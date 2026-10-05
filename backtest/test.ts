// Focused offline confidence checks for the backtesting sandbox. No provider call, no network, no
// live config, no shared-cache writes. Run:
//
//   deno test --allow-read=.publication-audit/backtesting,/home/codex/repos/0x4007/jev-sandbox \
//     --allow-write=.publication-audit/backtesting --allow-run=uv,python3 \
//     --allow-env=HOME,PATH,OPENROUTER_API_KEY,JEV_CACHE backtest/test.ts

// Local assertion helpers keep the tests offline: no jsr/npm fetch, no network at all.
function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}: ${a} != ${b}`);
}
async function assertRejects(
  fn: () => Promise<unknown>,
  errorType: new (...args: never[]) => Error,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = error instanceof errorType;
    if (!threw) throw new Error(`wrong error type: ${String(error)}`);
  }
  if (!threw) throw new Error("expected rejection");
}
function assertThrows(fn: () => unknown, message = "expected throw"): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

import {
  buildPanel,
  fileSha256,
  hash16,
  pairHash,
  splitByConversation,
} from "./lib/panel.ts";
import {
  importGatedLabels,
  type LocalSnapshotRow,
  readJsonl,
} from "./lib/labelimport.ts";
import { carrierFor, parseSessionText } from "./lib/transcript.ts";
import { scrubText } from "./lib/scrub.ts";
import {
  assertCandidateImmutable,
  proposeCandidates,
} from "./lib/candidate.ts";
import {
  bestFloor,
  devImproves,
  heldoutGate,
  metrics,
  scoreCases,
} from "./lib/gate.ts";
import {
  adaptLegacyInstructions,
  CacheUnavailable,
  childEnv,
  estimateCostUsd,
  fixedPythonArgv,
  ProviderError,
  runBatch,
} from "./lib/jev.ts";
import { replayJudge } from "./lib/judge.ts";
import { DEFAULTS } from "./lib/config.ts";
import { privacyHits } from "../jev/dataset/validate.ts";
import { selectQueue } from "./lib/queueselect.ts";
import { joinGatedLabels } from "./run.ts";
import { candidatesFrom } from "./prepare.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function sessionFixture(): string {
  const meta = {
    type: "session_meta",
    payload: {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      thread_source: "user",
      source: "vscode",
      cwd: "/tmp/work",
      originator: "codex_exec",
    },
  };
  const start = (turn: string) => ({
    type: "event_msg",
    payload: { type: "task_started", turn_id: turn, started_at: 1000 },
  });
  const done = (turn: string) => ({
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turn,
      last_agent_message: "unused",
    },
  });
  const user = (text: string) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
  const final = (text: string) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  });
  const commentary = (text: string) => ({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text }],
    },
  });
  return [
    line(meta),
    line(start("t1")),
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>noise" }],
      },
    }),
    line(user("first steering instruction")),
    line(commentary("mid-turn narration")),
    line(user("late steering correction that must win")),
    // Duplicate carrier: same content as the previous user message through event_msg item_completed.
    line({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "late steering correction that must win",
          }],
        },
      },
    }),
    line(final("The requested work is complete.")),
    line(done("t1")),
    line(start("t2")),
    line(user("# AGENTS.md instructions for /tmp/work")),
    line(user("second real steering")),
    line(done("t2")),
    line(start("t3")),
    line(user("open turn steering")),
    line(final("This open turn must not be paired.")),
  ].join("");
}

Deno.test("parser pairs late steering and final phase; skips injected, duplicate carrier, open turn", () => {
  const parsed = parseSessionText(sessionFixture(), "/tmp/fixture.jsonl");
  assertEquals(parsed.pairs.length, 1);
  assertEquals(
    parsed.pairs[0].request,
    "late steering correction that must win",
  );
  assertEquals(parsed.pairs[0].final, "The requested work is complete.");
  assertEquals(parsed.stats.turns_open_at_eof, 1);
  assertEquals(parsed.stats.turns_missing_final_phase, 1);
  assertEquals(parsed.stats.duplicate_carrier_items_ignored, 1);
  assert(parsed.stats.steering_injected_skipped >= 1);
});

Deno.test("carrier classification rejects children and this audit workspace", () => {
  assertEquals(
    carrierFor({
      id: "a",
      thread_source: "user",
      source: "vscode",
      cwd: "/tmp/x",
    }),
    "root_user",
  );
  assertEquals(
    carrierFor({
      id: "a",
      thread_source: "subagent",
      source: { subagent: true },
      cwd: "/tmp/x",
    }),
    "child",
  );
  assertEquals(
    carrierFor({
      id: "a",
      thread_source: "user",
      source: "vscode",
      parent_thread_id: "b",
      cwd: "/tmp/x",
    }),
    "child",
  );
  assertEquals(
    carrierFor({
      id: "a",
      thread_source: "user",
      source: "exec",
      cwd: "/home/codex/.local/state/repo-public-audit-x/y",
    }),
    "observer",
  );
});

Deno.test("dedupe collapses duplicate turns and copied text; split keeps groups disjoint", () => {
  const base = {
    tier: "session" as const,
    sessionId: "s1",
    turnId: "t1",
    request: "do the thing",
    final: "done, here is the summary of the thing",
    startedAt: 1,
    sourcePath: "a.jsonl",
    ordinal: 0,
  };
  const pairs = [
    base,
    { ...base, sourcePath: "b.jsonl" },
    { ...base, turnId: "t2", sourcePath: "c.jsonl" },
    {
      ...base,
      sessionId: "s2",
      turnId: "t3",
      request: "other task",
      final: "other task finished completely",
      sourcePath: "d.jsonl",
    },
  ];
  const panel = buildPanel(pairs, {
    ...DEFAULTS,
    minFinalChars: 8,
    minRequestChars: 4,
  });
  assertEquals(panel.cases.length, 2);
  assertEquals(panel.duplicates.same_turn, 1);
  assertEquals(panel.duplicates.copied_text, 1);
  const split = splitByConversation(panel.cases);
  const seen = new Set<string>();
  for (const bucket of [split.train, split.dev, split.lockedHeldout]) {
    for (const c of bucket) {
      assert(!seen.has(c.groupId), "group leaked across splits");
      seen.add(c.groupId);
    }
  }
});

Deno.test("secret guard redacts and fails closed on a surviving private key", () => {
  const soft = scrubText(
    "contact me at dev@example.com or /home/alice/project",
  );
  assert(soft.ok);
  assert(!soft.text.includes("dev@example.com"));
  assert(!soft.text.includes("/home/alice/"));
  const hard = scrubText(
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  );
  assertEquals(hard.ok, false);
  assertEquals(
    hard.text,
    "",
    "quarantine must not release the raw text as usable",
  );
});

Deno.test("captured commands stay inert data and the bridge argv is constant", async () => {
  const sentinelDir = await Deno.makeTempDir();
  const sentinel = `${sentinelDir}/pwned`;
  const caseText = `please run: touch ${sentinel} && rm -rf /tmp/nothing`;
  const panel = buildPanel(
    [{
      tier: "session",
      sessionId: "s",
      turnId: "t",
      request: caseText,
      final: "The command was captured as text and never executed.",
      startedAt: 1,
      sourcePath: "x",
      ordinal: 0,
    }],
    DEFAULTS,
  );
  assertEquals(panel.cases.length, 1);
  assertEquals(
    panel.cases[0].userRequest.includes("touch"),
    true,
    "command strings remain inert data",
  );
  let seenArgv: string[] = [];
  let existsDuring = false;
  await runBatch({ work: {} }, [{
    id: "c1",
    user_request: caseText,
    assistant_final: "x",
  }], {
    cwd: "/tmp",
    spawn: (argv) => {
      seenArgv = argv;
      existsDuring = (() => {
        try {
          Deno.statSync(sentinel);
          return true;
        } catch {
          return false;
        }
      })();
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          status: "ok",
          results: [],
          metrics: {
            dir: "/tmp/mock-cache",
            hits: 0,
            misses: 0,
            input_tokens_bought: 0,
            input_tokens_replayed: 0,
          },
          wire_sha256: "mock",
        }),
        stderr: "",
      });
    },
  });
  assertEquals(seenArgv, fixedPythonArgv());
  assertEquals(seenArgv.some((a) => a.includes("touch")), false);
  assertEquals(existsDuring, false);
  await Deno.remove(sentinelDir, { recursive: true });
});

Deno.test("mock bridge uses an isolated cache env and never returns partial provider errors", async () => {
  const tempCache = await Deno.makeTempDir();
  let envSeen: Record<string, string> = {};
  const ok = await runBatch({}, [{
    id: "c1",
    user_request: "a",
    assistant_final: "b",
  }], {
    cwd: "/tmp",
    cacheDir: tempCache,
    spawn: (_argv, _cwd, env) => {
      envSeen = env;
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          status: "ok",
          results: [{
            id: "c1",
            choice: "finished",
            confidence: 0.9,
            probabilities: { authorized_unfinished: 0.05 },
            replayed: true,
            ms: 1,
          }],
          metrics: {
            dir: tempCache,
            hits: 1,
            misses: 0,
            input_tokens_bought: 0,
            input_tokens_replayed: 10,
          },
        }),
        stderr: "",
      });
    },
  });
  assertEquals(envSeen.JEV_CACHE, tempCache);
  assertEquals(
    envSeen.OPENROUTER_API_KEY,
    Deno.env.get("OPENROUTER_API_KEY") ?? undefined,
  );
  assertEquals(ok.results[0].replayed, true);
  assertEquals(
    childEnv(undefined).JEV_CACHE,
    Deno.env.get("JEV_CACHE") ?? undefined,
  );
  await assertRejects(
    () =>
      runBatch({}, [{ id: "c1", user_request: "a", assistant_final: "b" }], {
        cwd: "/tmp",
        cacheDir: tempCache,
        spawn: () =>
          Promise.resolve({
            code: 3,
            stdout: "",
            stderr: "429 Too Many Requests",
          }),
      }),
    ProviderError,
  );
  await assertRejects(
    () =>
      runBatch({}, [{ id: "c1", user_request: "a", assistant_final: "b" }], {
        cwd: "/tmp",
        cacheDir: tempCache,
        spawn: (_argv, _cwd, env) => {
          // Prove the isolated cache dir is never the shared SDK cache for mock runs.
          assertEquals(env.JEV_CACHE, tempCache);
          return Promise.resolve({
            code: 3,
            stdout: JSON.stringify({
              status: "provider-error",
              error: "TypeSafeError",
            }),
            stderr: "boom",
          });
        },
      }),
    ProviderError,
  );
  await Deno.remove(tempCache, { recursive: true });
});

Deno.test("candidate edits are single-field and immutable elsewhere", () => {
  const base = {
    work: {
      type: "choice",
      instructions: { question: "Assess remaining work.", focus: "focus text" },
      criteria: {
        finished: { what: "finished text" },
        authorized_unfinished: { what: "authorized text" },
        waiting: { what: "waiting text" },
        unclear: { what: "unclear text" },
      },
    },
  };
  const dev = [
    {
      id: "d1",
      label: "finished",
      labelConfidence: "high",
      choice: "authorized_unfinished",
      pAu: 0.9,
      replayed: false,
      resume: true,
    },
    {
      id: "d2",
      label: "finished",
      labelConfidence: "high",
      choice: "authorized_unfinished",
      pAu: 0.8,
      replayed: false,
      resume: true,
    },
    {
      id: "d3",
      label: "authorized_unfinished",
      labelConfidence: "high",
      choice: "authorized_unfinished",
      pAu: 0.7,
      replayed: false,
      resume: true,
    },
  ];
  const candidates = proposeCandidates(base, dev, DEFAULTS);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].editPath, "work.criteria.finished.what");
  assertCandidateImmutable(base, candidates[0]);
  const tampered = JSON.parse(
    JSON.stringify(candidates[0]),
  ) as typeof candidates[0];
  (tampered.questions as typeof base).work.type = "noul";
  assertThrows(() => assertCandidateImmutable(base, tampered));
  const secondTamper = JSON.parse(
    JSON.stringify(candidates[0]),
  ) as typeof candidates[0];
  (secondTamper.questions as typeof base).work.criteria.waiting.what =
    "changed";
  assertThrows(() => assertCandidateImmutable(base, secondTamper));
  assertEquals(
    JSON.stringify(candidates[0].questions).includes('"examples"'),
    false,
  );
  // Candidates are template-driven: no dev case content or id is copied in, so text from any
  // input the proposer must not see could never appear in the generated question.
  const serialized = JSON.stringify(candidates[0].questions);
  assertEquals(dev.some((row) => serialized.includes(row.id)), false);
  assertEquals(serialized.includes("HELDOUT-ONLY-TEXT-9f31c2"), false);
});

Deno.test("gates reject regression and floor selection stays on dev", () => {
  const labeled = [
    { id: "a", label: "finished", labelConfidence: "high" },
    { id: "b", label: "authorized_unfinished", labelConfidence: "high" },
  ];
  const champion = metrics(
    scoreCases(labeled, [
      {
        id: "a",
        choice: "finished",
        confidence: 1,
        probabilities: { authorized_unfinished: 0.1 },
        replayed: false,
        ms: 1,
      },
      {
        id: "b",
        choice: "authorized_unfinished",
        confidence: 1,
        probabilities: { authorized_unfinished: 0.9 },
        replayed: false,
        ms: 1,
      },
    ], 0.56),
    0.56,
  );
  const regressed = metrics(
    scoreCases(labeled, [
      {
        id: "a",
        choice: "authorized_unfinished",
        confidence: 1,
        probabilities: { authorized_unfinished: 0.9 },
        replayed: false,
        ms: 1,
      },
      {
        id: "b",
        choice: "finished",
        confidence: 1,
        probabilities: { authorized_unfinished: 0.1 },
        replayed: false,
        ms: 1,
      },
    ], 0.56),
    0.56,
  );
  assertEquals(devImproves(regressed, champion).pass, false);
  assertEquals(heldoutGate(regressed, champion).pass, false);
  assertEquals(heldoutGate(champion, champion).pass, true);
  const sweep = bestFloor(
    scoreCases(labeled, [
      {
        id: "a",
        choice: "finished",
        confidence: 1,
        probabilities: { authorized_unfinished: 0.58 },
        replayed: false,
        ms: 1,
      },
      {
        id: "b",
        choice: "authorized_unfinished",
        confidence: 1,
        probabilities: { authorized_unfinished: 0.9 },
        replayed: false,
        ms: 1,
      },
    ], 0.56),
    [0.5, 0.56, 0.6],
  );
  assertEquals(sweep.floor, 0.6);
});

Deno.test("judge gate requires full coverage, privacy+context pass, and hash binding", async () => {
  const dir = await Deno.makeTempDir();
  const queuePath = `${dir}/blind-queue.json`;
  const items = Array.from({ length: 12 }, (_, i) => ({
    queue_id: `blind-${String(i).padStart(4, "0")}`,
    user_request: `user request number ${i} with enough words to be judgeable`,
    assistant_final:
      `assistant final number ${i} reporting a completed change with detail`,
  }));
  const queue = {
    version: 2,
    created_utc: "x",
    instruction: "i",
    windows: { request: 900, final: 1200 },
    items,
  };
  Deno.writeTextFileSync(queuePath, `${JSON.stringify(queue)}\n`);
  const entry = (
    item: (typeof items)[number],
    reviewer: string,
    label: string,
    privacy = true,
    context = true,
  ) => ({
    queue_id: item.queue_id,
    reviewer,
    label,
    confidence: "high",
    privacy_pass: privacy,
    context_sufficient: context,
    pair_sha256: pairHash(item.user_request, item.assistant_final),
    model: "deepseek-v4-ultra-max",
    exit_code: 0,
    header_verified: true,
    accepted: { header: "Ultra/max", sandbox: "workspace-write/ask" },
  });
  const clean = items.flatMap((
    item,
    i,
  ) => [
    entry(item, "A", i === 3 ? "waiting" : "finished"),
    entry(item, "B", i === 3 ? "waiting" : "finished"),
  ]);
  const gated = replayJudge(queuePath, queue, clean, DEFAULTS);
  assertEquals(gated.status, "gated");
  assertEquals(gated.labels.length, 12);
  assertEquals(gated.agreement?.rate, 1);

  // One privacy rejection anywhere fails the gate and emits no labels.
  const privacy = clean.map((row) =>
    row.queue_id === items[0].queue_id && row.reviewer === "B"
      ? { ...row, privacy_pass: false }
      : row
  );
  const privacyFailed = replayJudge(queuePath, queue, privacy, DEFAULTS);
  assertEquals(privacyFailed.status, "incomplete-coverage");
  assertEquals(privacyFailed.labels.length, 0);
  assertEquals(
    privacyFailed.quarantined.some((q) =>
      q.queue_id === items[0].queue_id && q.reason.includes("privacy_rejected")
    ),
    true,
  );

  // Context insufficiency is equally disqualifying.
  const context = clean.map((row) =>
    row.queue_id === items[1].queue_id && row.reviewer === "A"
      ? { ...row, context_sufficient: false }
      : row
  );
  assertEquals(
    replayJudge(queuePath, queue, context, DEFAULTS).labels.length,
    0,
  );

  // Incomplete coverage (one reviewer missing an item) fails closed.
  const missing = clean.filter((row) =>
    !(row.queue_id === items[2].queue_id && row.reviewer === "A")
  );
  const coverage = replayJudge(queuePath, queue, missing, DEFAULTS);
  assertEquals(coverage.status, "incomplete-coverage");
  assertEquals(coverage.labels.length, 0);

  // Stale queue binding and pair-hash mismatch both fail closed.
  assertEquals(
    replayJudge(queuePath, queue, clean, DEFAULTS, "0".repeat(64)).status,
    "stale-queue",
  );
  const badPair = clean.map((row) =>
    row.queue_id === items[4].queue_id
      ? { ...row, pair_sha256: "f".repeat(64) }
      : row
  );
  const pairFailed = replayJudge(queuePath, queue, badPair, DEFAULTS);
  assertEquals(pairFailed.status, "pair-hash-mismatch");
  assertEquals(pairFailed.labels.length, 0);

  // A label outside the four-way domain is rejected, and disagreement stays disputed.
  const offDomain = clean.map((row) =>
    row.queue_id === items[5].queue_id ? { ...row, label: "unknownish" } : row
  );
  assertEquals(
    replayJudge(queuePath, queue, offDomain, DEFAULTS).labels.length,
    0,
  );
  const disputedRows = clean.map((row) =>
    row.queue_id === items[6].queue_id && row.reviewer === "B"
      ? { ...row, label: "waiting" }
      : row
  );
  const disputed = replayJudge(queuePath, queue, disputedRows, DEFAULTS);
  assertEquals(disputed.labels.length, 0);
  assertEquals(disputed.disputed, [items[6].queue_id]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("legacy string instructions are adapted for every arm and compile offline on the SDK", async () => {
  const stringDoc = {
    work: {
      type: "choice",
      instructions: "original task text",
      criteria: { finished: { what: "f" } },
    },
  };
  const objectDoc = {
    work: {
      type: "choice",
      instructions: { question: "q", focus: "f" },
      criteria: { finished: { what: "f" } },
    },
  };
  const a = adaptLegacyInstructions(stringDoc);
  assertEquals(a.adapterApplied, ["work"]);
  assertEquals((a.questions as typeof stringDoc).work.instructions, {
    task: "original task text",
  });
  const b = adaptLegacyInstructions(objectDoc);
  assertEquals(b.adapterApplied, []);
  assertEquals(JSON.stringify(b.questions), JSON.stringify(objectDoc));

  const sandbox = "/home/codex/repos/0x4007/jev-sandbox";
  const snap = `${Deno.cwd()}/.publication-audit/backtesting/writer-questions`;
  const files = [
    "question-auto-f69158a.json",
    "question-pre-cc9d055.json",
    "question-cur-8317dd1.json",
  ];
  const script = [
    "import json, sys",
    "from jev_sandbox import wire",
    "paths = " + JSON.stringify(files.map((f) => `${snap}/${f}`)),
    "ok = []",
    "for p in paths:",
    "    q = json.load(open(p))",
    "    ins = q['work'].get('instructions')",
    "    if isinstance(ins, str): q['work']['instructions'] = {'task': ins}",
    "    wire.questions_from_json(q)",
    "    ok.append(p.split('/')[-1])",
    "print(json.dumps({'compiled': ok}))",
  ].join("\n");
  const output = await new Deno.Command("uv", {
    args: ["run", "python", "-c", script],
    cwd: sandbox,
    env: {
      HOME: Deno.env.get("HOME") ?? "",
      PATH: Deno.env.get("PATH") ?? "",
      UV_CACHE_DIR: "/tmp/uvcache-backtest",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    output.code,
    0,
    new TextDecoder().decode(output.stderr).slice(0, 300),
  );
  const parsed = JSON.parse(
    new TextDecoder().decode(output.stdout).trim().split("\n").pop() as string,
  ) as { compiled: string[] };
  assertEquals(parsed.compiled.length, 3);
});

Deno.test("unknown usage is never zero and a disabled cache fails closed", async () => {
  const cases = [{ id: "c1", user_request: "a", assistant_final: "b" }];
  const unknown = await runBatch({}, cases, {
    cwd: "/tmp",
    spawn: () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({
          status: "ok",
          results: [{
            id: "c1",
            choice: "finished",
            confidence: 1,
            probabilities: { authorized_unfinished: 0.1 },
            replayed: false,
            ms: 1,
          }],
          metrics: {
            dir: "/tmp/x",
            hits: 0,
            misses: 1,
            input_tokens_bought: null,
            input_tokens_replayed: 0,
          },
          wire_sha256: "abc",
        }),
        stderr: "",
      }),
  });
  assertEquals(unknown.metrics?.inputTokensBought, null);
  assertEquals(
    estimateCostUsd(unknown.metrics?.inputTokensBought ?? null, 0.042),
    null,
  );
  assertEquals(estimateCostUsd(0, 0.042), 0);
  await assertRejects(
    () =>
      runBatch({}, cases, {
        cwd: "/tmp",
        spawn: () =>
          Promise.resolve({
            code: 0,
            stdout: JSON.stringify({
              status: "ok",
              results: [],
              metrics: null,
            }),
            stderr: "",
          }),
      }),
    CacheUnavailable,
  );
});

Deno.test("gated labels join queue_id and pair hash to source case, group and split", async () => {
  const dir = await Deno.makeTempDir();
  const queuePath = `${dir}/blind-queue.json`;
  const items = Array.from({ length: 12 }, (_, i) => ({
    queue_id: `blind2-${String(i).padStart(4, "0")}`,
    user_request:
      `please finish remaining migration step ${i} in the frozen snapshot`,
    assistant_final:
      `migration step ${i} is complete and verified against the staging checks`,
  }));
  Deno.writeTextFileSync(
    queuePath,
    `${
      JSON.stringify({
        version: 2,
        created_utc: "x",
        instruction: "i",
        windows: { request: 900, final: 1200 },
        items,
      })
    }\n`,
  );
  const mapPath = `${dir}/map.json`;
  Deno.writeTextFileSync(
    mapPath,
    JSON.stringify({
      queue_sha256: fileSha256(queuePath),
      map: Object.fromEntries(
        items.map((
          item,
          i,
        ) => [item.queue_id, {
          case_id: `localcase${i}`,
          group_id: `g${i}`,
          tier: "session",
          split: "dev",
          hash: "h",
          source_hash: "h",
          source_pair_sha256: pairHash(
            item.user_request,
            item.assistant_final,
          ),
        }]),
      ),
    }),
  );
  const splitPath = `${dir}/split.json`;
  Deno.writeTextFileSync(
    splitPath,
    JSON.stringify({
      dev_ids: items.map((_, i) => `localcase${i}`),
      locked_heldout_ids: [],
    }),
  );
  const snapPath = `${dir}/snapshot.jsonl`;
  const writeSnapshot = (
    mutate: (row: Record<string, string>, i: number) => Record<string, string>,
  ) =>
    Deno.writeTextFileSync(
      snapPath,
      items.map((item, i) =>
        `${
          JSON.stringify(
            mutate({
              id: `localcase${i}`,
              group_id: `g${i}`,
              tier: "session",
              user_request: item.user_request,
              assistant_final: item.assistant_final,
              hash: "h",
              source_path: "x",
            }, i),
          )
        }\n`
      ).join(""),
    );
  writeSnapshot((row) => row);
  const annotationPath = (reviewer: string) => `${dir}/${reviewer}.jsonl`;
  for (const reviewer of ["A", "B"]) {
    Deno.writeTextFileSync(
      annotationPath(reviewer),
      items.map((item) =>
        `${
          JSON.stringify({
            queue_id: item.queue_id,
            reviewer,
            label: "finished",
            confidence: "high",
            privacy_pass: true,
            context_sufficient: true,
            pair_sha256: pairHash(item.user_request, item.assistant_final),
          })
        }\n`
      ).join(""),
    );
  }
  const result = importGatedLabels({
    queuePath,
    mapPath,
    splitPath,
    snapshotPaths: [snapPath],
    annotationPaths: [{ reviewer: "A", path: annotationPath("A") }, {
      reviewer: "B",
      path: annotationPath("B"),
    }],
    expectedQueueSha256: fileSha256(queuePath),
    cfg: DEFAULTS,
  });
  assertEquals(result.status, "gated");
  assertEquals(result.labels.length, 12);
  assertEquals(result.labels[0].case_id, "localcase0");
  assertEquals(result.labels[0].split, "dev");
  assertEquals(
    result.labels[0].pair_sha256,
    pairHash(items[0].user_request, items[0].assistant_final),
  );
  // A source text mismatch quarantines the joined label instead of silently binding it.
  writeSnapshot((row, i) =>
    i === 0
      ? { ...row, user_request: "different request text entirely here" }
      : row
  );
  const mismatched = importGatedLabels({
    queuePath,
    mapPath,
    splitPath,
    snapshotPaths: [snapPath],
    annotationPaths: [{ reviewer: "A", path: annotationPath("A") }, {
      reviewer: "B",
      path: annotationPath("B"),
    }],
    expectedQueueSha256: fileSha256(queuePath),
    cfg: DEFAULTS,
  });
  assertEquals(mismatched.labels.length, 0);
  assertEquals(
    mismatched.quarantined.some((q) =>
      q.reason.includes("source provenance pair hash mismatch")
    ),
    true,
  );
  // A wrong source-provenance hash is equally disqualifying (guard stays meaningful).
  const wrongProvenance = JSON.parse(Deno.readTextFileSync(mapPath)) as {
    map: Record<string, { source_pair_sha256: string }>;
  };
  wrongProvenance.map["blind2-0000"].source_pair_sha256 = "f".repeat(64);
  const wrongProvenancePath = `${dir}/map-wrong-provenance.json`;
  Deno.writeTextFileSync(wrongProvenancePath, JSON.stringify(wrongProvenance));
  const provenanceFailed = importGatedLabels({
    queuePath,
    mapPath: wrongProvenancePath,
    splitPath,
    snapshotPaths: [snapPath],
    annotationPaths: [{ reviewer: "A", path: annotationPath("A") }, {
      reviewer: "B",
      path: annotationPath("B"),
    }],
    expectedQueueSha256: fileSha256(queuePath),
    cfg: DEFAULTS,
  });
  assertEquals(provenanceFailed.labels.length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("offline SDK cache check: stable keys, distinct inputs, corrupt entry is a miss", async () => {
  const sandbox = "/home/codex/repos/0x4007/jev-sandbox";
  const tempCache = await Deno.makeTempDir();
  const script = [
    "import json, os, pathlib",
    "from jev_sandbox.cache import ExactCache, request_key",
    "state = {'user_request': 'hello', 'assistant_final': 'world'}",
    "questions = {'work': {'type': 'choice', 'instructions': {'question': 'q'}, 'criteria': {}}}",
    "k1 = request_key(state, questions, model='jev-1.13.0')",
    "k2 = request_key(state, questions, model='jev-1.13.0')",
    "k3 = request_key({'user_request': 'other', 'assistant_final': 'world'}, questions, model='jev-1.13.0')",
    "d = pathlib.Path(os.environ['JEV_CACHE']); d.mkdir(parents=True, exist_ok=True)",
    "(d / (k1 + '.json')).write_text('{not json')",
    "print(json.dumps({'stable': k1 == k2, 'distinct': k1 != k3, 'corrupt_is_miss': ExactCache(d)._entry(k1) is None}))",
  ].join("\n");
  const command = new Deno.Command("uv", {
    args: ["run", "python", "-c", script],
    cwd: sandbox,
    env: {
      HOME: Deno.env.get("HOME") ?? "",
      PATH: Deno.env.get("PATH") ?? "",
      JEV_CACHE: tempCache,
      UV_CACHE_DIR: `${tempCache}/uv`,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(
    output.code,
    0,
    new TextDecoder().decode(output.stderr).slice(0, 300),
  );
  const parsed = JSON.parse(
    new TextDecoder().decode(output.stdout).trim().split("\n").pop() as string,
  ) as Record<string, boolean>;
  assertEquals(parsed.stable, true);
  assertEquals(parsed.distinct, true);
  assertEquals(parsed.corrupt_is_miss, true);
  await Deno.remove(tempCache, { recursive: true });
});

Deno.test("different panel input hashes differently (freeze drift is detectable)", () => {
  assertEquals(hash16({ a: 1 }), hash16({ a: 1 }));
  assert(hash16({ a: 1 }) !== hash16({ a: 2 }));
});

Deno.test("privacy guard removes every reviewed residual category and leaves neutral text intact", () => {
  const cases: Array<[string, string]> = [
    ["https://github.com/acme/private-repo/pull/77", "[URL]"],
    ["open vps.example.com now", "[HOST]"],
    [
      "key SHA256:AbCdEf0123456789AbCdEf0123456789AbCdEf01234",
      "SHA256:[SSH_FINGERPRINT]",
    ],
    [
      "artifact deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "[HASH]",
    ],
    ["continuation to A0abcdef1-1a2b-3c4d-5e6f-7a8b9c0d1e2f", "[ID]"],
    ["turn0fedcba9-1a2b-3c4d-5e6f-7a8b9c0d1e2f closed", "[TURN_ID]"],
    ["detached, PID **123456**.", "PID [PID]"],
    [
      "worktree name alpha-bravo-charlie-delta-g0123abc",
      "[WORKTREE]",
    ],
    [
      "on branch codex/alpha-bravo-charlie-delta-g0123abc;",
      "[BRANCH]",
    ],
    ["preserved in sample-project-private.", "[PRIVATE_REPO]"],
    ["approved0xabc123 identity", "approved [ACCOUNT]"],
    ["handoffs/sample-doc-2026-01-01.md in full", "[INTERNAL_DOC]"],
    ["- **Username:** `codex`", "**Username:** `[HOST_USER]`"],
    ["PR #42 is merged and #17 too", "[ISSUE]"],
  ];
  for (const [input, expected] of cases) {
    const result = scrubText(input);
    assertEquals(result.ok, true);
    assert(result.text.includes(expected), `${input} -> ${result.text}`);
  }
  const citation = scrubText(
    "<oai-mem-citation>\nMEMORY.md:1-2|note=[x]\n</oai-mem-citation>",
  );
  assertEquals(citation.ok, true);
  assertEquals(citation.text, "[MEMORY_CITATION]");
  const neutral =
    "The requested fix is complete and deployed; CI and browser checks passed.";
  assertEquals(scrubText(neutral).text, neutral);
});

Deno.test("v3 queue is hash-bound, label-free, and free of residual identifiers", async () => {
  const B = ".publication-audit/backtesting";
  const v2 = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v2/blind-queue.json`),
  ) as { items: Array<Record<string, string>> };
  const v3 = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v3/blind-queue.json`),
  ) as {
    version: number;
    replaces_queue_sha256: string;
    items: Array<Record<string, string>>;
  };
  const map = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v3/blind-queue-map.private.json`),
  ) as {
    queue_sha256: string;
    replaces_queue_sha256: string;
    map: Record<
      string,
      {
        pair_sha256: string;
        split: string;
        group_id: string;
        source_pair_sha256: string;
      }
    >;
  };
  const manifest = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v3/MANIFEST.json`),
  ) as Record<string, unknown>;
  const verification = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v3/verification.private.json`),
  ) as {
    changed_items: string[];
    unchanged_items: string[];
    guard: { residual_hits: number; public_validator_hits: number };
  };
  assertEquals(v3.version, 3);
  assertEquals(v3.items.length, 12);
  assertEquals(
    v3.items.map((i) => i.queue_id),
    v2.items.map((i) => i.queue_id),
  );
  assertEquals(map.queue_sha256, fileSha256(`${B}/writer-v3/blind-queue.json`));
  assertEquals(manifest.v3_queue_sha256, map.queue_sha256);
  assertEquals(
    map.replaces_queue_sha256,
    fileSha256(`${B}/writer-v2/blind-queue.json`),
  );
  assertEquals(verification.guard.residual_hits, 0);
  assertEquals(verification.guard.public_validator_hits, 0);
  assertEquals(verification.changed_items.length, 9);
  assertEquals(verification.unchanged_items.length, 3);
  for (const item of v3.items) {
    const text = `${item.user_request}\n${item.assistant_final}`;
    assertEquals(privacyHits(text), []);
    const meta = map.map[item.queue_id];
    assertEquals(
      meta.pair_sha256,
      pairHash(item.user_request, item.assistant_final),
    );
    if (verification.unchanged_items.includes(item.queue_id)) {
      const before = v2.items.find((i) =>
        i.queue_id === item.queue_id
      ) as Record<string, string>;
      assertEquals(item.user_request, before.user_request);
      assertEquals(item.assistant_final, before.assistant_final);
      assertEquals(meta.pair_sha256, meta.source_pair_sha256);
    }
  }
  // Labels are never prefilled for a corrected queue.
  let labelsFileExists = true;
  try {
    Deno.statSync(`${B}/writer-v3/local-labels-gated-v3.private.jsonl`);
  } catch {
    labelsFileExists = false;
  }
  assertEquals(labelsFileExists, false);
});

Deno.test("v4 subset is selected, excludes the quarantined case, and keeps 11 unchanged pairs", () => {
  const B = ".publication-audit/backtesting";
  const selected = selectQueue(B);
  assertEquals(selected.version, 4);
  const v4 = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v4/blind-queue.json`),
  ) as { items: Array<Record<string, string>> };
  const v3 = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v3/blind-queue.json`),
  ) as { items: Array<Record<string, string>> };
  const map = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v4/blind-queue-map.private.json`),
  ) as {
    queue_sha256: string;
    map: Record<string, Record<string, unknown>>;
  };
  const ledger = JSON.parse(
    Deno.readTextFileSync(`${B}/writer-v4/quarantine-ledger.private.json`),
  ) as {
    quarantined: Array<
      { queue_id: string; reviewer_reasons: Record<string, string[]> }
    >;
  };
  assertEquals(v4.items.length, 11);
  assertEquals(Object.keys(map.map).length, 11);
  assertEquals(map.queue_sha256, selected.queueSha256);
  assertEquals(v4.items.some((item) => item.queue_id === "blind2-0011"), false);
  assertEquals(ledger.quarantined.length, 1);
  assertEquals(ledger.quarantined[0].queue_id, "blind2-0011");
  assertEquals(Object.keys(ledger.quarantined[0].reviewer_reasons).length, 2);
  for (const item of v4.items) {
    const before = v3.items.find((i) => i.queue_id === item.queue_id) as Record<
      string,
      string
    >;
    assertEquals(item.user_request, before.user_request);
    assertEquals(item.assistant_final, before.assistant_final);
  }
});

Deno.test("v4 label import binds approved queue text for the provider and source text for provenance", () => {
  const B = ".publication-audit/backtesting";
  const V4 = `${B}/writer-v4`;
  const result = importGatedLabels({
    queuePath: `${V4}/blind-queue.json`,
    mapPath: `${V4}/blind-queue-map.private.json`,
    splitPath: `${B}/writer-cases/local-split.private.json`,
    snapshotPaths: [
      `${B}/writer-snapshot/local-primary.private.jsonl`,
      `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
    ],
    annotationPaths: [
      { reviewer: "reviewer-a", path: `${V4}/reviewer-a-annotations.jsonl` },
      { reviewer: "reviewer-b", path: `${V4}/reviewer-b-annotations.jsonl` },
    ],
    expectedQueueSha256: fileSha256(`${V4}/blind-queue.json`),
    cfg: DEFAULTS,
  });
  assertEquals(result.status, "gated");
  assertEquals(result.labels.length, 11);
  assertEquals(result.splits, { dev: 6, "locked-heldout": 5 });
  const queue = JSON.parse(Deno.readTextFileSync(`${V4}/blind-queue.json`)) as { items: Array<Record<string, string>> };
  const items = new Map(queue.items.map((i) => [i.queue_id, i]));
  const source = new Map<string, Record<string, string>>();
  for (const path of [`${B}/writer-snapshot/local-primary.private.jsonl`, `${B}/writer-snapshot/local-db-pointer.private.jsonl`]) {
    for (const line of Deno.readTextFileSync(path).split("\n")) {
      if (line.trim()) {
        const row = JSON.parse(line) as Record<string, string>;
        source.set(row.id, row);
      }
    }
  }
  const provenance = JSON.parse(Deno.readTextFileSync(`${V4}/source-pair-provenance.private.json`)) as {
    entries: Record<string, { original_source_pair_sha256: string }>;
  };
  for (const label of result.labels) {
    const item = items.get(label.queue_id) as Record<string, string>;
    assertEquals(label.provider_request, item.user_request);
    assertEquals(label.provider_final, item.assistant_final);
    assertEquals(label.pair_sha256, pairHash(item.user_request, item.assistant_final));
    assertEquals(label.queue_pair_sha256, label.pair_sha256);
    const row = source.get(label.case_id) as Record<string, string>;
    assertEquals(label.source_case_pair_sha256, pairHash(row.user_request, row.assistant_final));
    assertEquals(label.source_case_pair_sha256, provenance.entries[label.queue_id].original_source_pair_sha256);
  }
});

Deno.test("actual v4 loop join resolves all 11 accepted labels including the 5 DB-tier cases", () => {
  const B = ".publication-audit/backtesting";
  const V4 = `${B}/writer-v4`;
  const result = importGatedLabels({
    queuePath: `${V4}/blind-queue.json`,
    mapPath: `${V4}/blind-queue-map.private.json`,
    splitPath: `${B}/writer-cases/local-split.private.json`,
    snapshotPaths: [
      `${B}/writer-snapshot/local-primary.private.jsonl`,
      `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
    ],
    annotationPaths: [
      { reviewer: "reviewer-a", path: `${V4}/reviewer-a-annotations.jsonl` },
      { reviewer: "reviewer-b", path: `${V4}/reviewer-b-annotations.jsonl` },
    ],
    expectedQueueSha256: fileSha256(`${V4}/blind-queue.json`),
    cfg: DEFAULTS,
  });
  assertEquals(result.labels.length, 11);
  type PoolRow = {
    id: string;
    user_request: string;
    assistant_final: string;
    label: string;
  };
  const devPool = readJsonl<PoolRow>(`${B}/writer-cases/local-dev.private.jsonl`);
  const heldoutPool = readJsonl<PoolRow>(
    `${B}/writer-cases/local-locked-heldout.private.jsonl`,
  );
  const dbPointerPool = readJsonl<PoolRow>(
    `${B}/writer-snapshot/local-db-pointer.private.jsonl`,
  );
  const join = joinGatedLabels(result.labels, devPool, heldoutPool, dbPointerPool);
  assertEquals(join.quarantined.length, 0);
  assertEquals(join.dev.length, 6);
  assertEquals(join.heldout.length, 5);
  const dbTier = [...join.dev, ...join.heldout].filter((entry) => entry.label.tier === "db-pointer");
  assertEquals(dbTier.length, 5);
  const queue = JSON.parse(Deno.readTextFileSync(`${V4}/blind-queue.json`)) as { items: Array<Record<string, string>> };
  const items = new Map(queue.items.map((i) => [i.queue_id, i]));
  for (const entry of [...join.dev, ...join.heldout]) {
    const item = items.get(entry.label.queue_id) as Record<string, string>;
    assertEquals(entry.row.user_request, item.user_request);
    assertEquals(entry.row.assistant_final, item.assistant_final);
  }
});

Deno.test("queue prep gates windows on Unicode codepoints, not UTF-16 units", () => {
  const astral = "😀";
  const snapshotRow = (
    id: string,
    user_request: string,
    assistant_final: string,
  ): LocalSnapshotRow => ({
    id,
    group_id: `group-${id}`,
    tier: "session",
    user_request,
    assistant_final,
    hash: "h",
    source_path: "fixture",
  });
  const prep = (rows: LocalSnapshotRow[]) =>
    candidatesFrom(rows, "dev", new Set<string>());
  const bmpFinal =
    "The requested work is complete and verified: the fixtures load, the queue builds, and all of the offline checks pass without touching private data.";
  const fill = (base: string, total: number) =>
    `${base} ${astral.repeat(total - Array.from(base).length - 1)}`;
  const words =
    "The requested work is complete and verified today with all checks passing now";

  // Exactly 900 astral codepoints (1785 UTF-16 units) must be in-window.
  const request900 = `please fix ${astral.repeat(885)} now`;
  assertEquals(Array.from(request900).length, 900);
  assertEquals(request900.length, 1785);
  const accepted = prep([snapshotRow("cap-astral", request900, bmpFinal)]);
  assertEquals(accepted.pool.length, 1);
  assertEquals(accepted.pool[0].request, request900);
  assertEquals(accepted.rejects.out_of_window, undefined);

  // A final of exactly 1200 astral codepoints is in-window too.
  const final1200 = fill(words, 1200);
  assertEquals(Array.from(final1200).length, 1200);
  const acceptedFinal = prep([
    snapshotRow("cap-astral-final", request900, final1200),
  ]);
  assertEquals(acceptedFinal.pool.length, 1);
  assertEquals(acceptedFinal.rejects.out_of_window, undefined);

  // One codepoint past either cap is a true overflow (the old UTF-16 count hid this).
  const request901 = `please fix ${astral.repeat(886)} now`;
  assertEquals(Array.from(request901).length, 901);
  const requestOver = prep([snapshotRow("over-astral", request901, bmpFinal)]);
  assertEquals(requestOver.pool.length, 0);
  assertEquals(requestOver.rejects.out_of_window, 1);
  const finalOverflow = prep([
    snapshotRow("over-astral-final", request900, fill(words, 1201)),
  ]);
  assertEquals(finalOverflow.pool.length, 0);
  assertEquals(finalOverflow.rejects.out_of_window, 1);

  // BMP text is unchanged: codepoint and UTF-16 counts agree at the same boundary.
  const bmpRequest = `please fix ${"x".repeat(885)} now`;
  assertEquals(bmpRequest.length, 900);
  assertEquals(Array.from(bmpRequest).length, bmpRequest.length);
  assertEquals(
    prep([snapshotRow("cap-bmp", bmpRequest, bmpFinal)]).pool.length,
    1,
  );
  const bmpOver = prep([
    snapshotRow("over-bmp", `please fix ${"x".repeat(886)} now`, bmpFinal),
  ]);
  assertEquals(bmpOver.pool.length, 0);
  assertEquals(bmpOver.rejects.out_of_window, 1);
});
