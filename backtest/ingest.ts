#!/usr/bin/env -S deno run --allow-read --allow-write=.publication-audit/backtesting --allow-run=git,zstd
// Zero-argument read-only ingestion and freeze. No model call, no network, no credential read.
//
//   deno run --allow-read=/home/codex/.codex,/home/codex/.local/state/repo-public-audit-20261004-135605/repository.git,. \
//     --allow-write=.publication-audit/backtesting --allow-run=git,zstd backtest/ingest.ts
//
// Produces, under the ignored private path: the scrubbed local snapshot with source mapping, the
// coverage manifest, the conversation-grouped local split, the frozen blind-annotation queue and
// its reviewer input, and the frozen public baseline inputs (heldout50 / dev49) with the three
// original question revisions extracted read-only from the private mirror.

import { loadConfig, pathsFor } from "./lib/config.ts";
import { runFixed } from "./lib/exec.ts";
import {
  buildPanel,
  ensurePrivateDir,
  publicBenchmark,
  type PublicCase,
  readPublicDataset,
  selectBlindQueue,
  splitByConversation,
  toScoringCase,
  writePrivateJson,
  writePrivateJsonl,
} from "./lib/panel.ts";
import { scanArchives, scanHistoryDb, scanSessions } from "./lib/transcript.ts";
import { scrubText } from "./lib/scrub.ts";
import type { JudgeQueue } from "./lib/judge.ts";
import { reviewerCommands } from "./lib/judge.ts";

const MIRROR_QUESTION_PATH = "jev/questions-mjolnir-work.json";

function gitShow(mirror: string, ref: string, path: string): string {
  const result = runFixed([
    "git",
    `--git-dir=${mirror}`,
    "show",
    `${ref}:${path}`,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `git show ${ref}:${path} failed: ${result.stderr.trim().slice(0, 200)}`,
    );
  }
  return result.stdout;
}

function verifySha16(
  label: string,
  text: string,
  expected: string,
  hashHex: (s: string) => string,
): void {
  const got = hashHex(text).slice(0, 16);
  if (got !== expected) {
    throw new Error(
      `${label}: content sha256_16 ${got} != expected ${expected}`,
    );
  }
}

async function main(): Promise<number> {
  const { config: cfg, overridden } = loadConfig();
  const P = pathsFor(cfg);
  const { hashHex, hash16 } = await import("./lib/panel.ts");
  const cutoffMs = Date.parse(cfg.cutoffUtc);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(`bad cutoff: ${cfg.cutoffUtc}`);
  }
  ensurePrivateDir(P.snapshotDir);
  ensurePrivateDir(P.questionsDir);
  ensurePrivateDir(P.casesDir);
  ensurePrivateDir(P.resultsDir);

  // 1. Local inventory (read-only).
  const active = scanSessions(cfg.sessionsRoot, cutoffMs);
  const archives = scanArchives(cfg.archivedRoot, cutoffMs);
  const localIds = new Set(
    [...active.files, ...archives.files].map((f) => f.sessionId),
  );
  const db = scanHistoryDb(cfg.historyDb, cutoffMs, localIds);

  // 2. Panels: canonical tiers feed the benchmark; db-pointer stays a separate provenance tier.
  const primary = buildPanel([...active.pairs, ...archives.pairs], cfg);
  const dbPanel = buildPanel(db.pairs, cfg);
  const split = splitByConversation(primary.cases);
  const blind = selectBlindQueue(split.lockedHeldout, cfg.blindQueueSize);

  // 3. Frozen blind-annotation input: no labels, no source ids, no future-user signals.
  const queue: JudgeQueue = {
    version: 1,
    created_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    instruction:
      "Read the user request and the assistant final reply. Label the turn with exactly one of: finished | authorized_unfinished | waiting | unclear. Use only the text shown. Do not use outside knowledge and do not guess the source.",
    windows: cfg.windows,
    items: blind.map((c, i) => ({
      queue_id: `blind-${String(i + 1).padStart(4, "0")}`,
      user_request: c.userRequest,
      assistant_final: c.assistantFinal,
    })),
  };
  const queueHash = hashHex(
    JSON.stringify([
      queue.instruction,
      ...queue.items.map((
        i,
      ) => [i.queue_id, i.user_request, i.assistant_final]),
    ]),
  );
  writePrivateJson(`${P.casesDir}/blind-queue.json`, queue);
  writePrivateJson(`${P.casesDir}/blind-queue-map.private.json`, {
    queue_sha256: queueHash,
    map: Object.fromEntries(
      blind.map((c, i) => [
        `blind-${String(i + 1).padStart(4, "0")}`,
        {
          case_id: c.id,
          group_id: c.groupId,
          tier: c.tier,
          hash: c.hash,
          chars: [c.userRequest.length, c.assistantFinal.length],
        },
      ]),
    ),
  });

  // 4. Local snapshot (scrubbed text + private source mapping) and the grouped split.
  writePrivateJsonl(
    `${P.snapshotDir}/local-primary.private.jsonl`,
    primary.cases.map((c) => ({
      id: c.id,
      group_id: c.groupId,
      tier: c.tier,
      turn_id: c.turnId,
      session_id: c.sessionId,
      source_path: c.sourcePath,
      started_at: c.startedAt,
      scrub_flags: c.scrubFlags,
      user_request: c.userRequest,
      assistant_final: c.assistantFinal,
      hash: c.hash,
    })),
  );
  writePrivateJsonl(
    `${P.snapshotDir}/local-db-pointer.private.jsonl`,
    dbPanel.cases.map((c) => ({
      id: c.id,
      group_id: c.groupId,
      tier: c.tier,
      turn_id: c.turnId,
      thread_id: c.sessionId,
      source_path: c.sourcePath,
      started_at: c.startedAt,
      scrub_flags: c.scrubFlags,
      user_request: c.userRequest,
      assistant_final: c.assistantFinal,
      hash: c.hash,
    })),
  );
  writePrivateJson(`${P.casesDir}/local-split.private.json`, {
    assignments: split.assignments,
    train_ids: split.train.map((c) => c.id),
    dev_ids: split.dev.map((c) => c.id),
    locked_heldout_ids: split.lockedHeldout.map((c) => c.id),
  });
  writePrivateJsonl(
    `${P.casesDir}/local-locked-heldout.private.jsonl`,
    split.lockedHeldout.map((c) => ({ ...toScoringCase(c) })),
  );
  writePrivateJsonl(
    `${P.casesDir}/local-train.private.jsonl`,
    split.train.map((c) => ({ ...toScoringCase(c) })),
  );
  writePrivateJsonl(
    `${P.casesDir}/local-dev.private.jsonl`,
    split.dev.map((c) => ({ ...toScoringCase(c) })),
  );

  // 5. Frozen public benchmark inputs.
  let dataset: PublicCase[] = [];
  try {
    dataset = readPublicDataset(cfg.dataset);
  } catch {
    dataset = [];
  }
  const benchmark = publicBenchmark(dataset, cfg);
  writePrivateJsonl(
    `${P.casesDir}/public-heldout50.private.jsonl`,
    benchmark.heldout.map((c) => ({
      ...toScoringCase(c),
      label: c.label,
      label_confidence: c.labelConfidence,
      group_id: c.groupId,
    })),
  );
  writePrivateJsonl(
    `${P.casesDir}/public-dev49.private.jsonl`,
    benchmark.dev.map((c) => ({
      ...toScoringCase(c),
      label: c.label,
      label_confidence: c.labelConfidence,
      group_id: c.groupId,
    })),
  );
  writePrivateJson(`${P.casesDir}/public-benchmark.private.json`, {
    heldout: benchmark.heldout.map((c) => ({
      id: c.id,
      group_id: c.groupId,
      label: c.label,
      label_confidence: c.labelConfidence,
    })),
    dev: benchmark.dev.map((c) => ({
      id: c.id,
      group_id: c.groupId,
      label: c.label,
    })),
    excluded_dev_anchor: benchmark.excludedDevAnchor,
  });

  // 6. Original question revisions, read-only from the private mirror.
  const arms: Record<
    string,
    { ref: string; path: string; sha256_16: string; content: string }
  > = {};
  for (const [arm, ref] of Object.entries(cfg.questionCommits)) {
    const content = gitShow(cfg.mirrorGitDir, ref, MIRROR_QUESTION_PATH);
    const expected = cfg.questionSha16[arm as keyof typeof cfg.questionSha16];
    verifySha16(`question ${arm} (${ref})`, content, expected, hashHex);
    const path = `${P.questionsDir}/question-${arm}-${ref}.json`;
    Deno.writeTextFileSync(path, content, { mode: 0o600 });
    arms[arm] = {
      ref,
      path,
      sha256_16: hashHex(content).slice(0, 16),
      content: "",
    };
  }

  // 7. original18 fit control, preserved privately and screened; the raw rows are never sent.
  let original18: Record<string, unknown> = { available: false };
  try {
    const raw = gitShow(cfg.mirrorGitDir, "main", "jev/feedback-corpus.jsonl");
    const rows = raw.split("\n").filter((l) => l.trim()).map((l) =>
      JSON.parse(l) as Record<string, unknown>
    );
    const survivors = rows.filter((row) => {
      const a = scrubText(String(row.user_request ?? ""));
      const b = scrubText(String(row.assistant_final ?? ""));
      return a.ok && b.ok &&
        String(row.user_request ?? "").trim().length >= 8 &&
        String(row.assistant_final ?? "").trim().length >= 40;
    });
    const cached = gitShow(
      cfg.mirrorGitDir,
      "main",
      "jev/score-examples-teaching-2026-10-03-2.json",
    );
    Deno.writeTextFileSync(
      `${P.snapshotDir}/original18-raw.private.jsonl`,
      raw,
      { mode: 0o600 },
    );
    Deno.writeTextFileSync(
      `${P.snapshotDir}/original18-cached-fit.private.json`,
      cached,
      { mode: 0o600 },
    );
    const cachedDoc = JSON.parse(cached) as Record<string, unknown>;
    original18 = {
      available: true,
      rows: rows.length,
      labels: rows.reduce<Record<string, number>>((acc, r) => {
        const key = String(r.expected ?? "unknown");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      guard_survivors: survivors.length,
      publication_grade_filter_reference:
        "the earlier publication-grade entity filter kept 3/18; guard survivors are not publication-ready",
      raw_stored_privately: true,
      provider_use:
        "none: raw18 is preserved privately and never sent; cached fit control only",
      cached_fit: {
        before_correct: cachedDoc.before_correct ?? null,
        after_correct: cachedDoc.after_correct ?? null,
        n: cachedDoc.n ?? null,
      },
    };
  } catch (error) {
    original18 = { available: false, error: String(error).slice(0, 200) };
  }

  // 8. Manifest and coverage report.
  const files = [
    `${P.snapshotDir}/local-primary.private.jsonl`,
    `${P.snapshotDir}/local-db-pointer.private.jsonl`,
    `${P.casesDir}/blind-queue.json`,
    `${P.casesDir}/blind-queue-map.private.json`,
    `${P.casesDir}/local-split.private.json`,
    `${P.casesDir}/public-heldout50.private.jsonl`,
    `${P.casesDir}/public-dev49.private.jsonl`,
    ...Object.values(arms).map((a) => a.path),
  ];
  const manifest = {
    generated_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    cutoff_utc: cfg.cutoffUtc,
    config_overridden: overridden,
    files: files.map((path) => ({
      path,
      bytes: Deno.statSync(path).size,
      sha256_16: hashHex(Deno.readTextFileSync(path)).slice(0, 16),
    })),
  };
  writePrivateJson(`${P.snapshotDir}/MANIFEST.json`, manifest);

  const report = {
    report: "backtest-ingest",
    mode: "read-only local ingestion; no inference, no network, no credentials",
    generated_utc: manifest.generated_utc,
    cutoff_utc: cfg.cutoffUtc,
    config_overridden: overridden,
    coverage: {
      active: active.stats,
      archives: archives.stats,
      history_db: db.stats,
      local_session_ids: localIds.size,
      claim_all_devices_captured: false,
      unavailable: {
        mac_and_other_hosts:
          "not on this host: Mac/other-device session store and any pre-2026-09-03 store not migrated into the local DB",
        db_only_threads_without_transcript_bytes: db.stats.db_only_threads,
        db_only_threads_without_message_bodies: db.stats.db_only_threads -
          db.stats.db_only_threads_with_message_bodies,
        db_only_threads_with_resolvable_pointer_pairs:
          db.stats.db_only_threads_with_resolvable_pointers,
      },
      note:
        "The 495 figure counts DB turn rows without a local transcript file using only the 40 root session ids. " +
        `This run excludes every local transcript id (root+child+archive, ${localIds.size}), leaving ${db.stats.db_only_threads} DB-only threads; ` +
        `${db.stats.db_only_threads_with_message_bodies} of them have both userMessage and agentMessage rows and ` +
        `${db.stats.db_only_threads_with_resolvable_pointers} expose first-user/final-agent pointers that resolve. ` +
        "The DB-only threads are ingested as a lower-confidence db-pointer tier, never as a benchmark arm.",
    },
    panel: {
      primary_cases: primary.cases.length,
      primary_by_tier: primary.cases.reduce<Record<string, number>>(
        (acc, c) => {
          acc[c.tier] = (acc[c.tier] ?? 0) + 1;
          return acc;
        },
        {},
      ),
      groups: new Set(primary.cases.map((c) => c.groupId)).size,
      train: split.train.length,
      dev: split.dev.length,
      locked_heldout: split.lockedHeldout.length,
      quarantined: primary.quarantined.reduce<Record<string, number>>(
        (acc, q) => {
          const key = q.reason.split(":")[0];
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        },
        {},
      ),
      duplicates: primary.duplicates,
      db_pointer_cases: dbPanel.cases.length,
      db_pointer_quarantined: dbPanel.quarantined.length,
    },
    blind_queue: {
      path: `${P.casesDir}/blind-queue.json`,
      size: queue.items.length,
      sha256_16: hashHex(JSON.stringify(queue)),
      repeated_annotation_ready: true,
      reviewer_commands: reviewerCommands(
        `${P.casesDir}/blind-queue.json`,
        6,
        2,
      ),
    },
    benchmark: {
      dataset: cfg.dataset,
      rows: dataset.length,
      heldout: benchmark.heldout.length,
      dev: benchmark.dev.length,
      excluded_dev_anchor: benchmark.excludedDevAnchor,
      question_arms: Object.fromEntries(
        Object.entries(arms).map((
          [k, v],
        ) => [k, { ref: v.ref, path: v.path, sha256_16: v.sha256_16 }]),
      ),
    },
    original18,
    privacy: {
      snapshot_dir_mode: "0700",
      files_mode: "0600",
      raw_text_location: P.snapshotDir,
      never_read: ["auth.json", "*.keys", "env credential files"],
      commands_executed: "none: captured command strings are inert data",
    },
  };
  writePrivateJson(`${P.resultsDir}/writer-ingest-report.json`, report);
  console.log(JSON.stringify(
    {
      ok: true,
      report: `${P.resultsDir}/writer-ingest-report.json`,
      primary_cases: primary.cases.length,
      split: {
        train: split.train.length,
        dev: split.dev.length,
        locked_heldout: split.lockedHeldout.length,
      },
      blind_queue: queue.items.length,
      heldout50: benchmark.heldout.length,
      dev49: benchmark.dev.length,
      db_pointer_cases: dbPanel.cases.length,
      coverage: report.coverage,
    },
    null,
    2,
  ));
  return 0;
}

if (import.meta.main) Deno.exit(await main());
export { main };
