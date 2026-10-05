#!/usr/bin/env -S deno run --allow-read --allow-write=.publication-audit/backtesting --allow-env=OPENROUTER_API_KEY,JEV_CACHE,HOME,PATH --allow-run=uv
// Zero-argument bounded protocol driver. Sandbox only: it never installs a hook, edits live config,
// or writes outside the ignored private path.
//
//   deno run --allow-read=.,/home/codex/repos/0x4007/jev-sandbox --allow-write=.publication-audit/backtesting \
//     --allow-env=OPENROUTER_API_KEY,JEV_CACHE,HOME,PATH --allow-run=uv backtest/run.ts
//
// Protocol (max 2 trials, max 400 logical requests per run, $0.05 ceiling):
//   1. AUTO / PRE / CUR on the frozen public heldout50 (AUTO is compiled through the legacy-string
//      instructions adapter before the first request, so the driver cannot fail on wire shape).
//   2. Champion (persisted, hash-verified, or CUR on first run) on public dev49 + the gated local
//      dev cases; deterministic candidate edits see BOTH dev error sets.
//   3. Winner on public heldout50 AND the gated local heldout cases; promotion requires both gates.
// A missing key, a provider error, an unverifiable cache, or an exhausted budget stops the run with
// a status; tokens/cost are UNKNOWN when the store cannot report them, never zero.

import { loadConfig, pathsFor } from "./lib/config.ts";
import {
  assertCandidateImmutable,
  type Candidate,
  proposeCandidates,
  questionContentHash,
} from "./lib/candidate.ts";
import {
  bestFloor,
  devImproves,
  heldoutGate,
  metrics,
  pairRuns,
  scoreCases,
  type ScoredCase,
} from "./lib/gate.ts";
import {
  CacheUnavailable,
  estimateCostUsd,
  keyPresent,
  runBatch,
} from "./lib/jev.ts";
import {
  fileSha256,
  hash16,
  pairHash,
  writePrivateJson,
  writePrivateJsonl,
} from "./lib/panel.ts";
import { readJsonl } from "./lib/labelimport.ts";
import { selectQueue } from "./lib/queueselect.ts";

interface ScoringRow {
  id: string;
  user_request: string;
  assistant_final: string;
  label: string;
  label_confidence?: string;
}

interface GatedLabel {
  queue_id: string;
  case_id: string;
  pair_sha256: string;
  queue_pair_sha256?: string;
  source_case_pair_sha256?: string;
  provider_request?: string;
  provider_final?: string;
  group_id: string;
  split: string;
  tier: string;
  label: string;
  confidence: string;
  label_authority: string;
  reviewers: string[];
  queue_sha256: string;
}

interface BatchRecord {
  tag: string;
  cases: number;
  hits: number;
  misses: number;
  boughtTokens: number | null;
  replayedCases: number;
  elapsedMs: number;
  cacheDir: string | null;
  wireSha256: string;
  adapterApplied: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const { config: cfg } = loadConfig();
  const P = pathsFor(cfg);
  const V2 = `${P.privateDir}/writer-v2`;
  const B = P.privateDir;
  const heldout = readJsonl<ScoringRow>(
    `${P.casesDir}/public-heldout50.private.jsonl`,
  );
  const dev = readJsonl<ScoringRow>(`${P.casesDir}/public-dev49.private.jsonl`);
  const localDevPool = readJsonl<ScoringRow>(
    `${P.casesDir}/local-dev.private.jsonl`,
  );
  const localHeldoutPool = readJsonl<ScoringRow>(
    `${P.casesDir}/local-locked-heldout.private.jsonl`,
  );
  const armQuestions = {
    auto: readJson(
      `${P.questionsDir}/question-auto-${cfg.questionCommits.auto}.json`,
    ) as Record<string, unknown>,
    pre: readJson(
      `${P.questionsDir}/question-pre-${cfg.questionCommits.pre}.json`,
    ) as Record<string, unknown>,
    cur: readJson(
      `${P.questionsDir}/question-cur-${cfg.questionCommits.cur}.json`,
    ) as Record<string, unknown>,
  };
  const armRawSha = {
    auto: fileSha256(
      `${P.questionsDir}/question-auto-${cfg.questionCommits.auto}.json`,
    ),
    pre: fileSha256(
      `${P.questionsDir}/question-pre-${cfg.questionCommits.pre}.json`,
    ),
    cur: fileSha256(
      `${P.questionsDir}/question-cur-${cfg.questionCommits.cur}.json`,
    ),
  };

  // Champion: persisted sandbox state, hash/model/window/version verified, never installed live.
  const championPath = `${V2}/champion.json`;
  const championQuestionPath = `${V2}/champion-question.json`;
  const persisted = readJson(championPath);
  const championVerification: Record<string, unknown> = {
    persisted: Boolean(persisted),
    reasons: [] as string[],
  };
  let championQuestions = armQuestions.cur as Record<string, unknown>;
  let championSource = "cur-default";
  let championFloor = cfg.floor;
  if (persisted && exists(championQuestionPath)) {
    const reasons: string[] = [];
    if (Number(persisted.version) !== cfg.version) {
      reasons.push("version mismatch");
    }
    if (String(persisted.model) !== cfg.model) reasons.push("model mismatch");
    if (JSON.stringify(persisted.windows) !== JSON.stringify(cfg.windows)) {
      reasons.push("window mismatch");
    }
    if (!cfg.floorGrid.includes(Number(persisted.floor))) {
      reasons.push("floor outside the fixed grid");
    }
    const rawSha = fileSha256(championQuestionPath);
    if (String(persisted.question_sha256_raw) !== rawSha) {
      reasons.push("champion question hash mismatch");
    }
    championVerification.reasons = reasons;
    championVerification.raw_sha256 = rawSha;
    championVerification.wire_sha256 = persisted.wire_sha256 ?? null;
    if (reasons.length === 0) {
      championQuestions = JSON.parse(
        Deno.readTextFileSync(championQuestionPath),
      ) as Record<string, unknown>;
      championSource = "persisted-sandbox-champion";
      championFloor = Number(persisted.floor);
    }
  } else if (persisted) {
    (championVerification.reasons as string[]).push(
      "champion question file missing",
    );
  }

  // Gated local labels for the newest hash-valid queue only; a corrected queue never consumes the
  // previous version's labels (different dir, different per-item pair hashes).
  const selectedQueue = selectQueue(B);
  const labelDir = selectedQueue.version === 1
    ? B
    : `${B}/writer-v${selectedQueue.version}`;
  const gated = readJsonl<GatedLabel>(
    `${labelDir}/local-labels-gated-v${selectedQueue.version}.private.jsonl`,
  );
  // Source records come from every frozen tier, including the db-pointer snapshot, so a gated
  // label whose case lives only in the DB tier still resolves; validation is identical for all.
  const localDbPointerPool = readJsonl<ScoringRow>(
    `${P.snapshotDir}/local-db-pointer.private.jsonl`,
  );
  const localJoin = joinGatedLabels(
    gated,
    localDevPool,
    localHeldoutPool,
    localDbPointerPool,
  );
  const localQuarantined = localJoin.quarantined;
  const localDev = localJoin.dev;
  const localHeldout = localJoin.heldout;
  const labeledHeldout = heldout.map((c) => ({
    id: c.id,
    label: c.label,
    labelConfidence: c.label_confidence ?? "unstated",
  }));
  const labeledDev = dev.map((c) => ({
    id: c.id,
    label: c.label,
    labelConfidence: c.label_confidence ?? "unstated",
  }));
  const localDevLabeled = localDev.map((l) => ({
    id: l.row.id,
    label: l.label.label,
    labelConfidence: l.label.confidence ?? "unstated",
  }));
  const localHeldoutLabeled = localHeldout.map((l) => ({
    id: l.row.id,
    label: l.label.label,
    labelConfidence: l.label.confidence ?? "unstated",
  }));
  const localHeldoutRows = localHeldout.map((l) => l.row);
  const budget = {
    logicalRequests: 0,
    paidCalls: 0,
    boughtTokens: 0,
    unknownBoughtTokens: false,
    replayedCalls: 0,
    costUsd: null as number | null,
  };
  const batches: BatchRecord[] = [];
  const generatedUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const report: Record<string, unknown> = {
    report: "backtest-run",
    generated_utc: generatedUtc,
    mode: "sandbox replay/paid protocol; no live hook, config, or policy change",
    config_version: cfg.version,
    scratch_version: cfg.scratchVersion,
    queue: {
      version: selectedQueue.version,
      path: selectedQueue.queuePath,
      sha256: selectedQueue.queueSha256,
    },
    inputs: {
      heldout: `${P.casesDir}/public-heldout50.private.jsonl`,
      heldout_hash: hash16(
        heldout.map((c) => [c.id, c.label, c.user_request, c.assistant_final]),
      ),
      heldout_n: heldout.length,
      dev: `${P.casesDir}/public-dev49.private.jsonl`,
      dev_hash: hash16(
        dev.map((c) => [c.id, c.label, c.user_request, c.assistant_final]),
      ),
      dev_n: dev.length,
      local_dev_available_pool: localDevPool.length,
      local_heldout_available_pool: localHeldoutPool.length,
      local_db_pointer_pool: localDbPointerPool.length,
      gated_local_labels: gated.length,
      gated_local_dev: localDev.length,
      gated_local_heldout: localHeldout.length,
      gated_local_quarantined: localQuarantined.length,
      local_label_quarantined: localQuarantined,
      local_label_sources: [
        ...new Set(gated.map((g) => `${g.queue_sha256}:${g.reviewers.join("+")}`)),
      ],
      question_raw_sha256: armRawSha,
      question_content_hashes_16: Object.fromEntries(
        Object.entries(armQuestions).map((
          [arm, q],
        ) => [arm, questionContentHash(q)]),
      ),
      question_file_sha256_16_verified_at_ingest: cfg.questionSha16,
      model: cfg.model,
      provider_route: "existing route.apply OpenRouter typesafe/jev-1.13",
      state_window: cfg.windows,
      floor: cfg.floor,
    },
    champion: {
      source: championSource,
      floor: championFloor,
      verification: championVerification,
    },
    budget: cfg.limits,
    root_commands: {
      ingest:
        "deno run --allow-read=/home/codex/.codex,/home/codex/.local/state/repo-public-audit-20261004-135605/repository.git,. --allow-write=.publication-audit/backtesting --allow-run=git,zstd backtest/ingest.ts",
      prepare:
        "deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/prepare.ts",
      run:
        "deno run --allow-read=.,/home/codex/repos/0x4007/jev-sandbox --allow-write=.publication-audit/backtesting --allow-env=OPENROUTER_API_KEY,JEV_CACHE,HOME,PATH --allow-run=uv backtest/run.ts",
      labels:
        "deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/labels.ts",
      tests:
        "deno test --allow-read=.publication-audit/backtesting,/home/codex/repos/0x4007/jev-sandbox,/tmp --allow-write=.publication-audit/backtesting,/tmp --allow-run=uv,python3 --allow-env=HOME,PATH,OPENROUTER_API_KEY,JEV_CACHE backtest/test.ts",
      note:
        "OPENROUTER_API_KEY must come from the existing runtime environment; no new env name, flag, or secret is introduced.",
    },
    batches,
  };

  const accumulate = (record: BatchRecord): void => {
    batches.push(record);
    budget.paidCalls += record.misses;
    if (record.boughtTokens === null && record.misses > 0) {
      budget.unknownBoughtTokens = true;
    } else budget.boughtTokens += record.boughtTokens ?? 0;
    budget.replayedCalls += record.replayedCases;
    budget.costUsd = budget.unknownBoughtTokens
      ? null
      : estimateCostUsd(budget.boughtTokens, cfg.limits.pricePerMInputTokens);
  };

  const guardBudget = (cases: number): void => {
    if (budget.logicalRequests + cases > cfg.limits.maxLogicalRequests) {
      throw new Error(
        `logical request cap: ${budget.logicalRequests} + ${cases} > ${cfg.limits.maxLogicalRequests}`,
      );
    }
    if (budget.costUsd !== null) {
      const meanTokens = budget.paidCalls > 0
        ? budget.boughtTokens / budget.paidCalls
        : 1505;
      const projected = budget.costUsd +
        (cases * meanTokens * cfg.limits.pricePerMInputTokens) / 1_000_000;
      if (projected > cfg.limits.costCeilingUsd) {
        throw new Error(
          `cost ceiling: projected $${projected.toFixed(5)} > $${cfg.limits.costCeilingUsd}`,
        );
      }
    }
  };

  const batch = async (
    tag: string,
    question: Record<string, unknown>,
    cases: ScoringRow[],
  ) => {
    guardBudget(cases.length);
    budget.logicalRequests += cases.length;
    const result = await runBatch(
      question,
      cases.map((c) => ({
        id: c.id,
        user_request: c.user_request,
        assistant_final: c.assistant_final,
      })),
      { cwd: cfg.jevSandbox },
    );
    if (result.status === "no-key") throw new NoKey();
    if (result.metrics === null) throw new CacheUnavailable("no metrics");
    accumulate({
      tag,
      cases: cases.length,
      hits: result.metrics.hits,
      misses: result.metrics.misses,
      boughtTokens: result.metrics.inputTokensBought,
      replayedCases: result.results.filter((r) => r.replayed).length,
      elapsedMs: result.elapsedMs,
      cacheDir: result.metrics.dir,
      wireSha256: result.wireSha256,
      adapterApplied: result.adapterApplied,
    });
    return result;
  };

  if (!keyPresent()) {
    report.status = "no-key";
    report.reason =
      "OPENROUTER_API_KEY is not present in the runtime environment; no request was made and no metric is reported.";
    report.budget_used = budget;
    writePrivateJson(`${P.resultsDir}/writer-run-report.json`, report);
    console.log(
      JSON.stringify({
        status: report.status,
        report: `${P.resultsDir}/writer-run-report.json`,
      }, null, 2),
    );
    return 0;
  }

  try {
    // 1. Fixed original-revision arms on the identical frozen public heldout50 (adapter applied).
    const armResults: Record<string, ScoredCase[]> = {};
    const armMetrics: Record<string, unknown> = {};
    for (const arm of ["auto", "pre", "cur"] as const) {
      const result = await batch(
        `arm-${arm}-heldout50`,
        armQuestions[arm],
        heldout,
      );
      const scored = scoreCases(labeledHeldout, result.results, cfg.floor);
      armResults[arm] = scored;
      armMetrics[arm] = {
        ...metrics(scored, cfg.floor),
        raw_sha256: armRawSha[arm],
        wire_sha256: result.wireSha256,
        adapter_applied: result.adapterApplied,
      };
      writePrivateJsonl(
        `${P.resultsDir}/score-${arm}-heldout50.private.jsonl`,
        scored,
      );
    }
    report.arms = armMetrics;
    report.paired = {
      auto_vs_cur: pairRuns(armResults.cur, armResults.auto),
      pre_vs_cur: pairRuns(armResults.cur, armResults.pre),
    };

    // 2. Champion + candidates see public dev and gated local dev only.
    const championDevPublic = await batch(
      "champion-dev49",
      championQuestions,
      dev,
    );
    const championDevPublicScored = scoreCases(
      labeledDev,
      championDevPublic.results,
      championFloor,
    );
    const championDevPublicMetrics = metrics(
      championDevPublicScored,
      championFloor,
    );
    let championLocal: {
      metrics: ReturnType<typeof metrics>;
      scored: ScoredCase[];
    } | null = null;
    if (localDev.length > 0) {
      const result = await batch(
        "champion-localdev",
        championQuestions,
        localDev.map((l) => l.row),
      );
      const scored = scoreCases(localDevLabeled, result.results, championFloor);
      championLocal = { metrics: metrics(scored, championFloor), scored };
    }
    const proposerDevRows = [
      ...championDevPublicScored,
      ...(championLocal?.scored ?? []),
    ];
    const championDevMetrics = metrics(proposerDevRows, championFloor);
    const floorSweep = bestFloor(proposerDevRows, cfg.floorGrid);
    const candidates = proposeCandidates(
      championQuestions,
      proposerDevRows,
      cfg,
    );
    if (
      candidates.length < cfg.limits.maxTrials &&
      floorSweep.floor !== championFloor
    ) {
      const floorOnly = {
        id: `trial-${candidates.length + 1}-floor-only`,
        trial: candidates.length + 1,
        kind: "floor_only",
        editPath: "work.instructions.question",
        sentence: "",
        floor: floorSweep.floor,
        questions: JSON.parse(JSON.stringify(championQuestions)) as Record<
          string,
          unknown
        >,
        hashes: {
          base: questionContentHash(championQuestions),
          candidate: questionContentHash(championQuestions),
          content: hash16({ floor: floorSweep.floor }),
        },
      } as unknown as Candidate;
      assertCandidateImmutable(championQuestions, floorOnly);
      candidates.push(floorOnly);
    }

    const trials: unknown[] = [];
    let winner: {
      candidate: Candidate;
      scored: ScoredCase[];
      m: ReturnType<typeof metrics>;
    } | null = null;
    for (const candidate of candidates.slice(0, cfg.limits.maxTrials)) {
      const result = await batch(
        `${candidate.id}-dev49`,
        candidate.questions,
        dev,
      );
      const scoredAtFloor = scoreCases(labeledDev, result.results, cfg.floor);
      const bestLocal = bestFloor(scoredAtFloor, cfg.floorGrid);
      const chosenFloor = candidate.kind === "floor_only"
        ? candidate.floor
        : bestLocal.floor;
      const adjusted = scoreCases(labeledDev, result.results, chosenFloor);
      const publicMetrics = metrics(adjusted, chosenFloor);
      let localMetrics: ReturnType<typeof metrics> | null = null;
      let localScored: ScoredCase[] = [];
      if (localDev.length > 0) {
        const localResult = await batch(
          `${candidate.id}-localdev`,
          candidate.questions,
          localDev.map((l) => l.row),
        );
        localScored = scoreCases(
          localDevLabeled,
          localResult.results,
          chosenFloor,
        );
        localMetrics = metrics(localScored, chosenFloor);
      }
      const combinedScored = [...adjusted, ...localScored];
      const combined = localMetrics
        ? metrics(combinedScored, chosenFloor)
        : publicMetrics;
      const gate = devImproves(combined, championDevMetrics);
      trials.push({
        id: candidate.id,
        kind: candidate.kind,
        edit_path: candidate.editPath,
        sentence: candidate.sentence,
        floor: chosenFloor,
        hashes: candidate.hashes,
        public_dev: publicMetrics,
        local_dev: localMetrics,
        combined_dev: combined,
        dev_gate: gate,
      });
      if (
        gate.pass &&
        (!winner || combined.binaryAccuracy > winner.m.binaryAccuracy ||
          (combined.binaryAccuracy === winner.m.binaryAccuracy &&
            combined.falseResumeAny < winner.m.falseResumeAny))
      ) {
        winner = {
          candidate: { ...candidate, floor: chosenFloor },
          scored: combinedScored,
          m: combined,
        };
      }
    }

    // 3. Winner on BOTH frozen evaluation sets.
    let promotion: Record<string, unknown> = {
      champion_before: championSource,
      champion_after: championSource,
      reasons: ["no dev-improving candidate selected"],
    };
    if (winner) {
      const heldoutPublic = await batch(
        `${winner.candidate.id}-heldout50`,
        winner.candidate.questions,
        heldout,
      );
      const winnerPublicScored = scoreCases(
        labeledHeldout,
        heldoutPublic.results,
        winner.candidate.floor,
      );
      const winnerPublicMetrics = metrics(
        winnerPublicScored,
        winner.candidate.floor,
      );
      const curWire = (armMetrics.cur as { wire_sha256: string }).wire_sha256;
      let championPublicMetrics = metrics(armResults.cur, cfg.floor);
      if (
        championSource !== "cur-default" && heldoutPublic.wireSha256 !== curWire
      ) {
        const championPublic = await batch(
          "champion-heldout50",
          championQuestions,
          heldout,
        );
        championPublicMetrics = metrics(
          scoreCases(labeledHeldout, championPublic.results, championFloor),
          championFloor,
        );
      }
      const publicGate = heldoutGate(
        winnerPublicMetrics,
        championPublicMetrics,
      );
      let localGate: { pass: boolean; reasons: string[] } | null = null;
      let winnerLocalMetrics: ReturnType<typeof metrics> | null = null;
      let championLocalMetrics: ReturnType<typeof metrics> | null = null;
      if (localHeldoutRows.length > 0) {
        if (
          winner.candidate.floor === championFloor &&
          winner.candidate.hashes.candidate ===
            questionContentHash(championQuestions)
        ) {
          winnerLocalMetrics = null;
        } else {
          const winnerLocal = await batch(
            `${winner.candidate.id}-localheldout`,
            winner.candidate.questions,
            localHeldoutRows,
          );
          winnerLocalMetrics = metrics(
            scoreCases(
              localHeldoutLabeled,
              winnerLocal.results,
              winner.candidate.floor,
            ),
            winner.candidate.floor,
          );
        }
        const champLocalResult = await batch(
          "champion-localheldout",
          championQuestions,
          localHeldoutRows,
        );
        championLocalMetrics = metrics(
          scoreCases(
            localHeldoutLabeled,
            champLocalResult.results,
            championFloor,
          ),
          championFloor,
        );
        localGate = winnerLocalMetrics
          ? heldoutGate(winnerLocalMetrics, championLocalMetrics)
          : { pass: false, reasons: ["winner equals champion"] };
      }
      writePrivateJsonl(
        `${P.resultsDir}/score-${winner.candidate.id}-heldout50.private.jsonl`,
        winnerPublicScored,
      );
      const promoted = publicGate.pass &&
        (localGate === null || localGate.pass);
      promotion = {
        champion_before: championSource,
        champion_after: promoted ? winner.candidate.id : championSource,
        winner: {
          id: winner.candidate.id,
          floor: winner.candidate.floor,
          hashes: winner.candidate.hashes,
        },
        public_heldout: winnerPublicMetrics,
        public_gate: publicGate,
        local_heldout: winnerLocalMetrics,
        local_champion: championLocalMetrics,
        local_heldout_n: localHeldoutRows.length,
        local_gate: localGate,
        reasons: promoted
          ? ["both dev improvement and evaluation gates passed"]
          : [...publicGate.reasons, ...(localGate?.reasons ?? [])],
      };
      if (promoted) {
        Deno.writeTextFileSync(
          championQuestionPath,
          `${JSON.stringify(winner.candidate.questions, null, 2)}\n`,
          { mode: 0o600 },
        );
        writePrivateJson(championPath, {
          version: cfg.version,
          promoted_utc: generatedUtc,
          source_run: generatedUtc,
          question_path: championQuestionPath,
          question_sha256_raw: fileSha256(championQuestionPath),
          wire_sha256: heldoutPublic.wireSha256,
          floor: winner.candidate.floor,
          model: cfg.model,
          windows: cfg.windows,
          source_arm: winner.candidate.id,
          gates: { public: publicGate, local: localGate },
        });
      }
    }

    report.dev = {
      champion: championDevMetrics,
      floor_sweep: floorSweep,
      trials,
    };
    report.promotion = promotion;
    const everyRecordReplayed = batches.length > 0 &&
      batches.every((b) => b.replayedCases === b.cases);
    const usageKnownZero = !budget.unknownBoughtTokens &&
      budget.boughtTokens === 0;
    report.replay = {
      logical_requests: budget.logicalRequests,
      paid_calls: budget.paidCalls,
      replayed_calls: budget.replayedCalls,
      bought_input_tokens: budget.unknownBoughtTokens
        ? null
        : budget.boughtTokens,
      cost_usd: budget.costUsd,
      cost_status: budget.unknownBoughtTokens ? "unknown" : "known",
      all_replay_zero_bought_tokens: everyRecordReplayed && usageKnownZero &&
        !budget.unknownBoughtTokens,
      cache_enabled: batches.every((b) => b.cacheDir !== null),
      note:
        "all_replay requires every record replay=true, usage known zero, and an enabled cache; unknown usage is never reported as zero",
    };
    report.status = "ok";
    let ingestReport: Record<string, unknown> = {};
    try {
      ingestReport = JSON.parse(
        Deno.readTextFileSync(`${P.resultsDir}/writer-ingest-report.json`),
      ) as Record<string, unknown>;
    } catch {
      ingestReport = {};
    }
    report.original18_fit_control = ingestReport.original18 ??
      { available: false };
    report.manual_stages = [
      "root supplies the existing OPENROUTER_API_KEY at run time and executes the paid protocol",
      "root runs two independent reviewers over the frozen v2 queue and places their annotation JSONL beside it",
      "promotion here is a sandbox recommendation only; no live hook/config is touched",
    ];
    writePrivateJson(`${P.resultsDir}/writer-run-report.json`, report);
    console.log(JSON.stringify(
      {
        status: report.status,
        champion: { source: championSource, floor: championFloor },
        arms: Object.fromEntries(
          Object.entries(armMetrics).map(([k, v]) => [k, {
            exact: (v as { exact: number }).exact,
            n: (v as { n: number }).n,
            falseResumeAny: (v as { falseResumeAny: number }).falseResumeAny,
            adapter_applied:
              (v as { adapter_applied: string[] }).adapter_applied,
            wire_sha256: (v as { wire_sha256: string }).wire_sha256.slice(
              0,
              16,
            ),
          }]),
        ),
        local_labels: {
          dev: localDev.length,
          heldout: localHeldout.length,
          quarantined: localQuarantined.length,
        },
        promotion,
        replay: report.replay,
        report: `${P.resultsDir}/writer-run-report.json`,
      },
      null,
      2,
    ));
    return 0;
  } catch (error) {
    const noKey = error instanceof NoKey;
    const message = error instanceof Error ? error.message : String(error);
    const budgetAbort = message.startsWith("logical request cap") ||
      message.startsWith("cost ceiling");
    const cacheIssue = error instanceof CacheUnavailable;
    report.status = noKey
      ? "no-key"
      : cacheIssue
      ? "cache-unavailable"
      : budgetAbort
      ? "budget-abort"
      : "provider-error";
    report.reason = message;
    report.promotion = {
      champion_before: championSource,
      champion_after: championSource,
      reasons: ["run aborted; champion unchanged"],
    };
    report.budget_used = budget;
    writePrivateJson(`${P.resultsDir}/writer-run-report.json`, report);
    console.error(
      JSON.stringify({ status: report.status, reason: report.reason }, null, 2),
    );
    return noKey ? 0 : 1;
  }
}

export function joinGatedLabels(
  gated: GatedLabel[],
  devPool: ScoringRow[],
  heldoutPool: ScoringRow[],
  dbPointerPool: ScoringRow[],
): {
  dev: Array<{ row: ScoringRow; label: GatedLabel }>;
  heldout: Array<{ row: ScoringRow; label: GatedLabel }>;
  quarantined: Array<{ case_id: string; reason: string }>;
} {
  const pools = new Map<string, ScoringRow>();
  for (const row of [...devPool, ...heldoutPool, ...dbPointerPool]) {
    pools.set(row.id, row);
  }
  const dev: Array<{ row: ScoringRow; label: GatedLabel }> = [];
  const heldout: Array<{ row: ScoringRow; label: GatedLabel }> = [];
  const quarantined: Array<{ case_id: string; reason: string }> = [];
  for (const label of gated) {
    const row = pools.get(label.case_id);
    if (!row) {
      quarantined.push({
        case_id: label.case_id,
        reason: "case not in frozen local pool",
      });
      continue;
    }
    // Provider input is the exact approved queue text; the frozen source row is provenance only.
    const providerRequest = label.provider_request ?? row.user_request;
    const providerFinal = label.provider_final ?? row.assistant_final;
    if (
      pairHash(providerRequest, providerFinal) !==
        (label.queue_pair_sha256 ?? label.pair_sha256)
    ) {
      quarantined.push({
        case_id: label.case_id,
        reason: "provider pair hash mismatch against the approved queue text",
      });
      continue;
    }
    if (
      label.source_case_pair_sha256 &&
      pairHash(row.user_request, row.assistant_final) !==
        label.source_case_pair_sha256
    ) {
      quarantined.push({
        case_id: label.case_id,
        reason:
          "source provenance pair hash mismatch against the frozen local text",
      });
      continue;
    }
    const scoringRow: ScoringRow = {
      id: row.id,
      user_request: providerRequest,
      assistant_final: providerFinal,
      label: label.label,
    };
    if (label.split === "dev") dev.push({ row: scoringRow, label });
    else if (label.split === "locked-heldout") {
      heldout.push({ row: scoringRow, label });
    } else {
      quarantined.push({
        case_id: label.case_id,
        reason: `label split ${label.split} is not dev or locked-heldout`,
      });
    }
  }
  return { dev, heldout, quarantined };
}

class NoKey extends Error {
  constructor() {
    super("device bridge reported no-key");
    this.name = "NoKey";
  }
}

if (import.meta.main) Deno.exit(await main());
export { main };
