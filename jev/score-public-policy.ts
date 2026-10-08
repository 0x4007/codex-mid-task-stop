#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
// Score the stop-guard decision policy on the public reviewed 100 (jev/dataset/cases.jsonl).
//
// Arms:
//   work_baseline        legacy `work` Choice: continue iff authorized_unfinished and p >= 0.56
//   probe_only           present_tense_v3 Noul probability >= 0.6
//   probe_plus_receipts  probe OR any mechanical text receipt (gates.ts textReceipts)
//
// Modes:
//   --fresh --question v3|work   run the jev-sandbox route (same runner the hook uses), write
//                                verdicts-<question>-fresh.json into the ignored run area, then compose
//   --from-verdicts FILE         compose from verdict files (repeatable); accepts this scorer's
//                                verdicts format or cached eval shapes (v3/dev probability maps,
//                                heldout eval with v3+work answers)
//
// Outputs: .publication-audit/stopguard-public100/results.json (ignored) and the published
// copy jev/public-policy-results.json. Public-safe: public ids only, no session text.
// Run: deno run --allow-read --allow-write --allow-run --allow-env jev/score-public-policy.ts --help
import { textReceipts, waitingSuppressor } from "./gates.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AUDIT = `${REPO}/.publication-audit/stopguard-public100`;
const CASES_PATH = `${REPO}/jev/dataset/cases.jsonl`;
const TRAIN_PATH = `${REPO}/jev/dataset/train/cases.jsonl`;
const PUBLISHED_PATH = `${REPO}/jev/public-policy-results.json`;
const V3_PATH = `${REPO}/jev/questions-present-tense-v3.json`;
const WORK_PATH = `${REPO}/jev/questions-mjolnir-work.json`;
const RESULTS_PATH = `${AUDIT}/results.json`;

/** The probe floor the live hook applies by default (CODEX_STOP_GUARD_PROBE_FLOOR). */
const FLOOR_PROBE = 0.6;
/** The legacy work-binary floor (CODEX_STOP_GUARD_MIN_PROBABILITY). */
const FLOOR_WORK_BINARY = 0.56;
const WINDOWS = { request: 900, final: 1200 };
const MAX_FRESH_CALLS = 500;

interface CaseRow {
  id: string;
  split: string;
  label: string;
  user_request: string;
  assistant_final: string;
}

interface Verdicts {
  v3: Map<string, number>;
  work: Map<string, { choice: string | null; probabilities: Record<string, number> | null }>;
  files: Array<{ file: string; sha256: string; kind: string; questions: string[] }>;
}

function fail(message: string): never {
  console.error(message);
  Deno.exit(2);
}

function loadCases(path: string): CaseRow[] {
  return Deno.readTextFileSync(path)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CaseRow);
}

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sha256File(path: string): Promise<string> {
  return await sha256Text(await Deno.readTextFile(path));
}

async function git(args: string[]): Promise<string> {
  try {
    const out = await new Deno.Command("git", {
      args: ["-C", REPO, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return "";
  }
}

// --- verdict file normalization -------------------------------------------

/** Accept this scorer's verdicts format plus the cached eval shapes used for re-composition. */
async function loadVerdicts(path: string): Promise<{
  v3: Array<[string, number]>;
  work: Array<[string, { choice: string | null; probabilities: Record<string, number> | null }]>;
  questions: string[];
  kind: string;
}> {
  const text = await Deno.readTextFile(path);
  return normalizeVerdicts(JSON.parse(text), path);
}

function normalizeVerdicts(raw: unknown, path: string): {
  v3: Array<[string, number]>;
  work: Array<[string, { choice: string | null; probabilities: Record<string, number> | null }]>;
  questions: string[];
  kind: string;
} {
  const v3: Array<[string, number]> = [];
  const work: Array<[string, { choice: string | null; probabilities: Record<string, number> | null }]> = [];
  const questions: string[] = [];
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") fail(`unrecognized verdicts file ${path}`);
  const record = raw as Record<string, unknown>;

  // This scorer's canonical verdicts file.
  if (record.schema === "public-policy-verdicts/v1") {
    const q = String(record.question ?? "");
    const results = Array.isArray(record.results) ? record.results : [];
    for (const row of results as Array<Record<string, unknown>>) {
      const id = String(row.id ?? "");
      if (!id) continue;
      if (q === "work") {
        work.push([id, {
          choice: row.choice == null ? null : String(row.choice),
          probabilities: (row.probabilities ?? null) as Record<string, number> | null,
        }]);
      } else {
        if (typeof row.p === "number") v3.push([id, row.p]);
      }
    }
    questions.push(q || "unknown");
    return { v3, work, questions, kind: "scorer-verdicts" };
  }

  // Cached eval shapes: `dev` as an id->probability object or an [id, p] pair list.
  if (record.dev && typeof record.dev === "object" && !Array.isArray(record.dev)) {
    for (const [id, p] of Object.entries(record.dev as Record<string, unknown>)) {
      if (typeof p === "number") v3.push([id, p]);
    }
    questions.push("v3");
  }
  if (Array.isArray(record.dev)) {
    for (const pair of record.dev as Array<[string, number]>) {
      if (Array.isArray(pair) && typeof pair[1] === "number") v3.push([String(pair[0]), pair[1]]);
    }
    questions.push("v3");
  }
  if (record.v3 && typeof record.v3 === "object") {
    for (const [id, p] of Object.entries(record.v3 as Record<string, unknown>)) {
      if (typeof p === "number") v3.push([id, p]);
    }
    questions.push("v3");
  }
  if (record.work && typeof record.work === "object") {
    for (const [id, entry] of Object.entries(record.work as Record<string, unknown>)) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const probs = (e.probabilities ?? null) as Record<string, number> | null;
      work.push([id, {
        choice: e.choice == null ? null : String(e.choice),
        probabilities: probs,
      }]);
    }
    questions.push("work");
  }
  if (v3.length || work.length) return { v3, work, questions, kind: "cached-eval" };
  errors.push(`no recognized v3/work answers in ${path}`);
  return fail(errors.join("; "));
}

// --- fresh run through the jev-sandbox route -------------------------------

const PYTHON_RUNNER = `
import json, sys, time
from jev_sandbox import route
route.apply()
from jev_sandbox import experiment
payload = json.loads(sys.stdin.read())
questions = payload["questions"]
mode = payload["mode"]
floor = payload["floor"]
results = []
for case in payload["cases"]:
    started = time.time()
    try:
        exp = experiment.run_json(
            {"user_request": case["user_request"][:900], "assistant_final": case["assistant_final"][:1200]},
            questions,
        )
        if mode == "work":
            if "work" in (getattr(exp, "choices", None) or {}):
                a = exp.choices["work"]
            else:
                a = exp.nouls["work"]
            row = {"id": case["id"], "choice": getattr(a, "choice", None),
                   "confidence": getattr(a, "confidence", None),
                   "probabilities": getattr(a, "probabilities", None)}
        else:
            a = exp.nouls["present_tense_v3"]
            row = {"id": case["id"], "p": float(a.noul)}
    except Exception as exc:
        print(json.dumps({"status": "provider-error", "case_id": case["id"],
                          "error": type(exc).__name__, "message": str(exc)[:400]}))
        sys.exit(3)
    row.update({
        "replayed": bool((exp.cache or {}).get("replayed")),
        "input_tokens": exp.input_tokens,
        "cost_usd": exp.cost_usd,
        "ms": round((time.time() - started) * 1000),
    })
    results.append(row)
print(json.dumps({"status": "ok", "results": results}))
`;

async function runFresh(question: "v3" | "work", cases: CaseRow[], repoHead: string, tree: string) {
  if (cases.length > MAX_FRESH_CALLS) {
    fail(`fresh run would exceed the ${MAX_FRESH_CALLS}-call budget: ${cases.length} cases`);
  }
  const questionsPath = question === "v3" ? V3_PATH : WORK_PATH;
  const questionsRaw = await Deno.readTextFile(questionsPath);
  const jevRepo = Deno.env.get("CODEX_STOP_GUARD_JEV_REPO") ??
    `${Deno.env.get("HOME")}/repos/0x4007/jev-sandbox`;
  const uv = Deno.env.get("CODEX_STOP_GUARD_UV") ?? "uv";
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) fail("OPENROUTER_API_KEY is not set; fresh mode needs the provider key");
  await Deno.mkdir(`${AUDIT}/uv-cache`, { recursive: true });
  await Deno.mkdir(`${AUDIT}/jev-cache`, { recursive: true });
  const env: Record<string, string> = {
    HOME: Deno.env.get("HOME") ?? "",
    PATH: Deno.env.get("PATH") ?? "",
    OPENROUTER_API_KEY: key,
    UV_CACHE_DIR: `${AUDIT}/uv-cache`,
    JEV_CACHE: `${AUDIT}/jev-cache`,
  };
  const payload = JSON.stringify({
    mode: question,
    floor: question === "v3" ? FLOOR_PROBE : FLOOR_WORK_BINARY,
    questions: JSON.parse(questionsRaw),
    cases: cases.map((c) => ({
      id: c.id,
      user_request: c.user_request,
      assistant_final: c.assistant_final,
    })),
  });
  const proc = new Deno.Command(uv, {
    args: ["run", "--no-sync", "python", "-c", PYTHON_RUNNER],
    cwd: jevRepo,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(payload));
  await writer.close();
  const { stdout, stderr, code } = await proc.output();
  const out = new TextDecoder().decode(stdout).trim();
  const err = new TextDecoder().decode(stderr).trim();
  if (code !== 0) {
    // Abort, never fall back: a partial metric would be fabricated.
    fail(`fresh ${question} run aborted (exit ${code}); no results written.\n${err.slice(-600)}`);
  }
  const last = out.split("\n").pop() ?? "";
  let parsed: { status?: string; results?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(last) as typeof parsed;
  } catch {
    fail(`fresh ${question} run produced unparseable output; no results written.\n${last.slice(0, 400)}`);
  }
  if (parsed.status !== "ok") fail(`fresh ${question} run reported ${parsed.status}; no results written.`);
  const results = parsed.results ?? [];
  if (results.length !== cases.length || results.some((r, i) => String(r.id) !== cases[i].id)) {
    fail(`fresh ${question} result ids/order mismatch; no results written.`);
  }
  let replayed = 0;
  let inputTokens = 0;
  let costUsd = 0;
  for (const row of results) {
    if (row.replayed === true) {
      replayed++;
      continue;
    }
    if (typeof row.input_tokens === "number") inputTokens += row.input_tokens;
    if (typeof row.cost_usd === "number") costUsd += row.cost_usd;
  }
  const file = `verdicts-${question}-fresh.json`;
  const verdictFile = {
    schema: "public-policy-verdicts/v1",
    question,
    generated_utc: new Date().toISOString(),
    repo_head: repoHead,
    working_tree: tree,
    windows: WINDOWS,
    floor: question === "v3" ? FLOOR_PROBE : FLOOR_WORK_BINARY,
    questions_sha256: await sha256File(questionsPath),
    results,
    spend: {
      logical_calls: results.length,
      replayed,
      input_tokens: inputTokens,
      cost_usd_reported: Number(costUsd.toFixed(8)),
    },
  };
  await Deno.writeTextFile(`${AUDIT}/${file}`, JSON.stringify(verdictFile, null, 2) + "\n");
  console.log(
    `fresh ${question}: ${results.length} calls (${replayed} replayed), ` +
      `$${costUsd.toFixed(6)} reported, input ${inputTokens} tokens -> ${AUDIT}/${file}`,
  );
  return file;
}

// --- composition ------------------------------------------------------------

function armSummary(
  decisions: Map<string, boolean | null>,
  rows: CaseRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const splits = ["dev", "heldout"] as const;
  let totalAnswered = 0;
  let totalCorrect = 0;
  const totalFn: string[] = [];
  const totalFp: string[] = [];
  for (const split of splits) {
    const splitRows = rows.filter((r) => r.split === split);
    const fn: string[] = [];
    const fp: string[] = [];
    let answered = 0;
    let correct = 0;
    for (const row of splitRows) {
      const decision = decisions.get(row.id);
      if (decision == null) continue;
      answered++;
      const truth = row.label === "authorized_unfinished";
      if (decision === truth) correct++;
      else if (truth) fn.push(row.id);
      else fp.push(row.id);
    }
    totalAnswered += answered;
    totalCorrect += correct;
    totalFn.push(...fn);
    totalFp.push(...fp);
    out[split] = {
      rows: splitRows.length,
      answered,
      correct,
      errors: { fn, fp },
    };
  }
  out.total = {
    rows: rows.length,
    answered: totalAnswered,
    correct: totalCorrect,
    errors: { fn: totalFn, fp: totalFp },
  };
  return out;
}

interface ComposeInput {
  rows: CaseRow[];
  verdicts: Verdicts;
  questionV3Sha: string;
  questionWorkSha: string;
  repoHead: string;
  tree: string;
  fresh: boolean;
  /** True when a fresh provider verdict file was loaded (even in a compose-only run). */
  ranFresh: boolean;
  commands: string[];
  notes: string[];
}

function compose(input: ComposeInput): Record<string, unknown> {
  const { rows, verdicts } = input;
  const probeDecisions = new Map<string, boolean | null>();
  const workDecisions = new Map<string, boolean | null>();
  const policyDecisions = new Map<string, boolean | null>();
  const cases: Array<Record<string, unknown>> = [];
  const receiptFlips: Array<Record<string, unknown>> = [];
  const byClass: Record<string, { fired: number; on_authorized_unfinished: number; on_other: number }> = {
    gate_unperformed_action: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
    gate_explicit_missing: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
    gate_in_progress_action: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
    gate_decision_locked: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
    gate_questions_without_attempt: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
    gate_promised_action: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
    gate_continuous_action: { fired: 0, on_authorized_unfinished: 0, on_other: 0 },
  };
  for (const row of rows) {
    const request = row.user_request.slice(0, WINDOWS.request);
    const final = row.assistant_final.slice(0, WINDOWS.final);
    const receipts = textReceipts(request, final);
    const firedClasses = Object.entries(receipts).filter(([, v]) => v).map(([k]) => k);
    const truth = row.label === "authorized_unfinished";
    for (const cls of firedClasses) {
      const bucket = byClass[cls];
      if (!bucket) continue;
      bucket.fired++;
      if (truth) bucket.on_authorized_unfinished++;
      else bucket.on_other++;
    }
    const v3p = verdicts.v3.get(row.id) ?? null;
    const work = verdicts.work.get(row.id) ?? null;
    const probe = v3p == null ? null : v3p >= FLOOR_PROBE;
    const workDecision = work == null
      ? null
      : work.choice === "authorized_unfinished" &&
        (work.probabilities?.authorized_unfinished ?? 0) >= FLOOR_WORK_BINARY;
    const policy = probe == null
      ? null
      : firedClasses.length > 0 ||
        (probe && !waitingSuppressor(final));
    probeDecisions.set(row.id, probe);
    workDecisions.set(row.id, workDecision);
    policyDecisions.set(row.id, policy);
    // Flips where the policy differs from the bare probe, in either direction: receipts widen
    // the arm and the waiting suppressor narrows it.
    if (probe !== policy) {
      receiptFlips.push({
        id: row.id,
        split: row.split,
        label: row.label,
        classes: firedClasses,
        correct: truth,
        direction: policy === true ? "receipt-widens" : "waiting-suppresses",
        fixed: policy === truth,
      });
    }
    cases.push({
      id: row.id,
      split: row.split,
      label: row.label,
      v3_p: v3p,
      work_choice: work?.choice ?? null,
      work_p_authorized_unfinished: work?.probabilities?.authorized_unfinished ?? null,
      receipts,
      receipts_fired: firedClasses,
      decide: { work_baseline: workDecision, probe_only: probe, probe_plus_receipts: policy },
      correct: {
        work_baseline: workDecision == null ? null : workDecision === truth,
        probe_only: probe == null ? null : probe === truth,
        probe_plus_receipts: policy == null ? null : policy === truth,
      },
    });
  }

  const trainRows = loadCases(TRAIN_PATH);
  const trainByClass: Record<string, number> = {
    gate_unperformed_action: 0,
    gate_explicit_missing: 0,
    gate_in_progress_action: 0,
    gate_decision_locked: 0,
    gate_questions_without_attempt: 0,
    gate_promised_action: 0,
    gate_continuous_action: 0,
  };
  const trainLabels = { authorized_unfinished: 0, finished: 0 };
  let trainFired = 0;
  for (const row of trainRows) {
    const receipts = textReceipts(
      row.user_request.slice(0, WINDOWS.request),
      row.assistant_final.slice(0, WINDOWS.final),
    );
    const fired = Object.entries(receipts).filter(([, v]) => v).map(([k]) => k);
    if (fired.length) trainFired++;
    for (const cls of fired) trainByClass[cls] = (trainByClass[cls] ?? 0) + 1;
    if (row.label === "authorized_unfinished") trainLabels.authorized_unfinished++;
    else trainLabels.finished++;
  }

  const coverage = {
    dev: rows.filter((r) => r.split === "dev").length,
    heldout: rows.filter((r) => r.split === "heldout").length,
    total: rows.length,
  };
  const widens = receiptFlips.filter((f) => f.direction === "receipt-widens");
  const suppresses = receiptFlips.filter((f) => f.direction === "waiting-suppresses");
  const flipsCorrect = widens.filter((f) => f.correct === true).length;
  const flipsIncorrect = widens.filter((f) => f.correct !== true).length;
  const suppressedFixed = suppresses.filter((f) => f.fixed === true).length;
  const suppressedBroken = suppresses.filter((f) => f.fixed !== true).length;
  return {
    schema: "public-policy-results/v1",
    generated_utc: new Date().toISOString(),
    repo_head: input.repoHead,
    working_tree: input.tree,
    question_v3_sha256: input.questionV3Sha,
    floors: { probe: FLOOR_PROBE, work_binary: FLOOR_WORK_BINARY },
    windows: WINDOWS,
    coverage,
    arms: {
      work_baseline: {
        rule: `work == authorized_unfinished AND p(authorized_unfinished) >= ${FLOOR_WORK_BINARY}`,
        floor: FLOOR_WORK_BINARY,
        summary: armSummary(workDecisions, rows),
      },
      probe_only: {
        rule: `present_tense_v3 noul >= ${FLOOR_PROBE}`,
        floor: FLOOR_PROBE,
        summary: armSummary(probeDecisions, rows),
      },
      probe_plus_receipts: {
        rule: "any text receipt OR (probe_only AND NOT waiting-suppressed); the waiting suppressor "
          + "applies to the probe arm only (claim contradiction is live-only; see notes)",
        floor: FLOOR_PROBE,
        summary: armSummary(policyDecisions, rows),
      },
    },
    receipt_slices: {
      by_class: byClass,
      flips: receiptFlips,
      flips_added_correct: flipsCorrect,
      flips_added_incorrect: flipsIncorrect,
      waiting_suppressed_fixed: suppressedFixed,
      waiting_suppressed_broken: suppressedBroken,
    },
    train678_receipts: {
      rows: trainRows.length,
      fired: trainFired,
      by_class: trainByClass,
      labels: trainLabels,
      note: "proxy labels; deterministic zero-model-call false-fire diagnostic",
    },
    cases,
    provenance: {
      fresh: input.fresh || input.ranFresh,
      commands: input.commands,
      verdicts_files: verdicts.files,
      questions: {
        "present_tense_v3": input.questionV3Sha,
        "mjolnir_work": input.questionWorkSha,
      },
    },
    notes: input.notes,
  };
}

// --- main -------------------------------------------------------------------

if (import.meta.main) {
  const args = Deno.args;
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "usage: score-public-policy.ts [--fresh --question v3|work] [--from-verdicts FILE ...]\n" +
        "  fresh: run the jev-sandbox route (bounded budget) and write verdicts-<question>-fresh.json\n" +
        "  no flags: compose from the canonical fresh verdict files when present",
    );
    Deno.exit(0);
  }
  let fresh = false;
  let question: "v3" | "work" = "v3";
  const fromVerdicts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--fresh") fresh = true;
    else if (token === "--question") {
      const value = args[++i];
      if (value !== "v3" && value !== "work") fail(`--question must be v3 or work, got ${value}`);
      question = value;
    } else if (token === "--from-verdicts") {
      const value = args[++i];
      if (!value) fail("--from-verdicts needs a file path");
      fromVerdicts.push(value);
    } else fail(`unknown argument: ${token}`);
  }

  const rows = loadCases(CASES_PATH);
  const repoHead = (await git(["rev-parse", "HEAD"])) || "unknown";
  const tree = (await git(["status", "--porcelain"])) === "" ? "clean" : "dirty";
  const questionV3Sha = await sha256File(V3_PATH);

  const verdicts: Verdicts = { v3: new Map(), work: new Map(), files: [] };
  let ranFresh = false;
  const commands = [
    "deno run --allow-read --allow-write --allow-run --allow-env jev/score-public-policy.ts" +
    (fresh ? ` --fresh --question ${question}` : "") +
    fromVerdicts.map((f) => ` --from-verdicts ${f}`).join(""),
  ];

  if (fresh) {
    const file = await runFresh(question, rows, repoHead, tree);
    const loaded = await loadVerdicts(`${AUDIT}/${file}`);
    for (const [id, p] of loaded.v3) verdicts.v3.set(id, p);
    for (const [id, w] of loaded.work) verdicts.work.set(id, w);
    verdicts.files.push({
      file,
      sha256: await sha256File(`${AUDIT}/${file}`),
      kind: "fresh",
      questions: loaded.questions,
    });
  }

  const explicit = fromVerdicts.length > 0 ? fromVerdicts : [];
  if (!fresh && explicit.length === 0) {
    // Default composition: use the canonical fresh verdict files when they exist.
    for (const candidate of ["verdicts-v3-fresh.json", "verdicts-work-fresh.json"]) {
      try {
        await Deno.stat(`${AUDIT}/${candidate}`);
        explicit.push(candidate);
      } catch { /* not present yet */ }
    }
    if (explicit.length === 0) {
      fail("nothing to compose: pass --fresh, --from-verdicts, or run after a fresh verdict file exists");
    }
  }

  for (const file of explicit) {
    // Resolve: absolute as-is; else the ignored run area first, then the repo root.
    let path = file.startsWith("/") ? file : "";
    if (!path) {
      const inAudit = file.replace(/^\.\//, "");
      try {
        await Deno.stat(`${AUDIT}/${inAudit}`);
        path = `${AUDIT}/${inAudit}`;
      } catch {
        path = `${REPO}/${inAudit}`;
      }
    }
    const loaded = await loadVerdicts(path);
    for (const [id, p] of loaded.v3) verdicts.v3.set(id, p);
    for (const [id, w] of loaded.work) verdicts.work.set(id, w);
    verdicts.files.push({
      file,
      sha256: await sha256Text(await Deno.readTextFile(path)),
      kind: loaded.kind,
      questions: loaded.questions,
    });
    // Record the command that produced each fresh verdict file, so provenance names
    // the paid run as well as this composition. A canonical verdicts file is a fresh
    // provider run by construction; cached eval files are labeled separately.
    const raw = JSON.parse(await Deno.readTextFile(path)) as { question?: string; schema?: string };
    if (raw.schema === "public-policy-verdicts/v1") ranFresh = true;
    if (raw.question === "v3" || raw.question === "work") {
      commands.push(
        `deno run --allow-read --allow-write --allow-run --allow-env ` +
          `jev/score-public-policy.ts --fresh --question ${raw.question}`,
      );
    }
  }

  const workSha = await sha256File(WORK_PATH);
  const notes = [
    "policy revision 2026-10-07 (offline pass): added gate_promised_action and gate_continuous_action receipts, tightened gate_unperformed_action to keep named pending work while dropping the explanatory 'changed it/the code yet' aside, and added the probe-arm waiting suppressor (waiting_suppressed); v3 verdict probabilities are the frozen 2026-10-06 fresh files, so this composition adds no provider calls",
    "claim_contradicted cannot be recomputed offline on dataset rows: they carry no transcripts; the live hook evaluates it from turn receipts, and is treated as false here (the widest suppressor scope)",
    "the two new receipt classes and the D tightening are fitted on dev residuals; heldout stays 50/50 and train678 is the false-fire control (<= 40 cap)",
    "heldout was consulted across earlier iterations: this is a regression set, not a blind prospective claim",
    "labels are independent agent review, not human ground truth",
    "fresh mode uses an isolated cache under .publication-audit/stopguard-public100; replays are reported per case",
  ];
  const results = compose({
    rows,
    verdicts,
    questionV3Sha,
    questionWorkSha: workSha,
    repoHead,
    tree,
    fresh,
    ranFresh,
    commands,
    notes,
  });

  await Deno.mkdir(AUDIT, { recursive: true });
  await Deno.writeTextFile(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
  await Deno.writeTextFile(PUBLISHED_PATH, JSON.stringify(results, null, 2) + "\n");
  const arms = results.arms as Record<string, { summary: { total: { answered: number; correct: number } } }>;
  for (const name of ["work_baseline", "probe_only", "probe_plus_receipts"]) {
    const s = arms[name].summary;
    console.log(`${name}: ${s.total.correct}/${s.total.answered} (answered of ${rows.length})`);
  }
  console.log(`wrote ${RESULTS_PATH}`);
  console.log(`wrote ${PUBLISHED_PATH}`);
}
