#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
// Codex Stop hook: request one continuation when the turn ended while authorized work remained.
//
// Deterministic gates run first and are free. The semantic judgement (jev) runs only when the
// gates pass, and the durable allowance is consumed before any continuation is emitted, so a turn can
// never be continued twice.

import { factsFor, textReceipts, textsFor } from "../jev/gates.ts";

const STATE_DIR = Deno.env.get("CODEX_STOP_GUARD_DIR") ??
  `${Deno.env.get("HOME")}/.local/state/codex-stop-guard`;
/** This checkout, resolved from the hook's own location, so no machine-specific path is baked in. */
const REPO = Deno.env.get("CODEX_STOP_GUARD_REPO") ??
  new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/** The detector runtime is a separate checkout; this default keeps its conventional location. */
const JEV_REPO = Deno.env.get("CODEX_STOP_GUARD_JEV_REPO") ??
  `${Deno.env.get("HOME")}/repos/0x4007/jev-sandbox`;
/** The uv executable that runs the python probe runner. */
const UV = Deno.env.get("CODEX_STOP_GUARD_UV") ?? "uv";
const DRY_RUN = Deno.env.get("CODEX_STOP_GUARD_DRY_RUN") === "1";

/** Minimum probability of `authorized_unfinished` required before resuming.
 *  The probe policy floor: v3 separates stops (0.59-0.96) from false ones (0.48-0.55);
 *  0.6 was the frozen zero-false-resume choice. Override with CODEX_STOP_GUARD_PROBE_FLOOR. */
const CONTINUE_MIN_PROBABILITY = Number(
  Deno.env.get("CODEX_STOP_GUARD_PROBE_FLOOR") ??
    Deno.env.get("CODEX_STOP_GUARD_MIN_PROBABILITY") ??
    Deno.env.get("CODEX_STOP_GUARD_MIN_CONFIDENCE") ??
    "0.6",
);

interface Event {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  stop_hook_active?: boolean;
  cwd?: string;
  /** Present on newer clients; the transcript turn-context record is the fallback. */
  model?: string;
  last_assistant_message?: string | null;
}

interface Decision {
  allow: boolean;
  reason: "dry-run" | "not-stop" | "already-active" | "no-transcript" | "model-gpt" | "tool-call-at-end" |
    "allowance-spent" | "decided-finished" | "decided-waiting" | "decided-unclear" |
    "jev-unavailable" | "jev-error" | "continue";
  evidence?: unknown;
}

/** The attributed reason shown when the guard requests a continuation.
 *  A continued turn never renders the visible systemMessage, so the score and cost must
 *  travel inside the reason -- it is the only text that survives a continuation. */
function continueReason(evidence: unknown, id: string): string {
  const jev = (evidence as { jev?: Verdict } | undefined)?.jev;
  const tr =
    (evidence as { text_receipts?: Record<string, boolean> } | undefined)
      ?.text_receipts ?? {};
  const fired = Object.entries(tr).filter(([, v]) => v).map(([k]) =>
    k.replace(/^gate_/, "")
  );
  const receiptPart = fired.length ? `, receipts: ${fired.join(",")}` : "";
  const detail = jev
    ? ` (${jev.choice ?? "?"} ${(jev.confidence ?? 0).toFixed(2)}${receiptPart}${
      jev.cost_usd != null ? `, $${jev.cost_usd.toFixed(6)}` : ""
    }, id ${id})`
    : ` (id ${id})`;
  return "[stop-guard] Turn ended mid-task" + detail +
    ". Continuing once. Continue the announced work, or state the blocker explicitly. " +
    `If nothing was pending, record the false positive: ${falsePositiveCommand(id)}`;
}

/** The exact command a resumed agent runs to record this continuation as a false positive. */
function falsePositiveCommand(id: string): string {
  return `${Deno.execPath()} run --allow-read --allow-write --allow-env ` +
    `${REPO}/jev/feedback.ts finished --id ${id} --note "no work remained"`;
}

/** First 8 characters of an id, enough to quote back without a wall of uuid. */
function shortId(value: string | undefined): string {
  if (!value) return "none";
  return value.replace(/-/g, "").slice(0, 8);
}

/** One execution's unique id: `sg.<session8>.<turn8>`, `.n` for a repeat in the same turn.
 *  `sg` names this hook; a second hook takes its own prefix so displays never collide. */
function executionId(session: string, turn: string, sequence: number): string {
  // Underscores only: terminals select the whole id on double-click, and the id stays one word.
  const base = `sg_${shortId(session)}_${shortId(turn)}`;
  return sequence > 1 ? `${base}_${sequence}` : base;
}

/** Prior rows that would share this execution's base id, so ids never repeat in a session. */
async function priorExecutions(session: string, turn: string): Promise<number> {
  let text = "";
  try {
    text = await Deno.readTextFile(`${STATE_DIR}/decisions.jsonl`);
  } catch {
    return 0;
  }
  const base = `sg_${shortId(session)}_${shortId(turn)}`;
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { session?: string; id?: string };
      const rid = row.id ?? "";
      if (row.session === session && (rid === base || rid.startsWith(base + "_"))) count += 1;
    } catch { /* skip a torn line */ }
  }
  return count;
}

/** A continuation that ran no tool calls is very likely a false resume; record it for review. */
async function recordNoWorkContinuation(
  session: string,
  turn: string,
  counts: Record<string, number>,
): Promise<void> {
  let text = "";
  try {
    text = await Deno.readTextFile(`${STATE_DIR}/decisions.jsonl`);
  } catch {
    return;
  }
  interface LogRow {
    id?: string;
    session?: string;
    turn?: string;
    decision?: string;
    transcript?: string | null;
    evidence?: { counts?: Record<string, number>; request_head?: string; final_head?: string };
  }
  let prior: LogRow | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as LogRow;
      if (row.session === session && row.turn === turn && row.decision === "continue") prior = row;
    } catch { /* skip a torn line */ }
  }
  if (!prior?.id) return;
  // Any new tool call since the continuation means it did work; only the no-work class is certain.
  if (JSON.stringify(counts) !== JSON.stringify(prior.evidence?.counts ?? {})) return;

  let feedback = "";
  try {
    feedback = await Deno.readTextFile(`${STATE_DIR}/feedback.jsonl`);
  } catch { /* none yet */ }
  if (feedback.includes(`"id":"${prior.id}"`)) return;

  const entry = {
    at: new Date().toISOString(),
    id: prior.id,
    session,
    turn,
    hook_decision: "continue",
    expected: null,
    auto: true,
    suspected_false_positive: true,
    note: "continuation ran no tool calls; likely a false resume",
    request: prior.evidence?.request_head ?? "",
    final: prior.evidence?.final_head ?? "",
    transcript: prior.transcript ?? null,
  };
  await Deno.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${STATE_DIR}/feedback.jsonl`, JSON.stringify(entry) + "\n", { append: true });
}

/** Running jev spend for one session, read from the decision log. The current execution is
 *  excluded by id -- its row is already written by the time the line is printed. */
async function sessionSpend(
  session: string,
  excludeId?: string,
): Promise<{ calls: number; usd: number; tokens: number; cached: number }> {
  let text = "";
  try {
    text = await Deno.readTextFile(`${STATE_DIR}/decisions.jsonl`);
  } catch {
    return { calls: 0, usd: 0, tokens: 0, cached: 0 };
  }
  let calls = 0;
  let usd = 0;
  let tokens = 0;
  let cached = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        session?: string;
        id?: string;
        evidence?: { jev?: { cost_usd?: number; input_tokens?: number; replayed?: boolean } };
      };
      const jev = row.evidence?.jev;
      if (row.session !== session || !jev) continue;
      if (excludeId && row.id === excludeId) continue;
      if (jev.replayed === true) {
        cached += 1;
        continue;
      }
      calls += 1;
      usd += jev.cost_usd ?? 0;
      tokens += jev.input_tokens ?? 0;
    } catch { /* skip a torn line */ }
  }
  return { calls, usd, tokens, cached };
}

function allowancePath(session: string, turn: string): string {
  return `${STATE_DIR}/allowance-${session}-${turn}.json`;
}

async function allowanceSpent(session: string, turn: string): Promise<boolean> {
  try {
    await Deno.stat(allowancePath(session, turn));
    return true;
  } catch {
    return false;
  }
}

async function consumeAllowance(session: string, turn: string, detail: unknown): Promise<void> {
  await Deno.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    allowancePath(session, turn),
    JSON.stringify({ session, turn, consumed_at: new Date().toISOString(), detail }, null, 2),
  );
}

/** Runs jev through the sandbox checkout. Returns undefined when jev cannot answer. */
interface Verdict {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  elapsed_ms?: number;
  replayed?: boolean;
  __error?: string;
}

async function judge(request: string, final: string): Promise<Verdict | undefined> {
  // Probe by default; `CODEX_STOP_GUARD_RUBRIC=work` restores the legacy rubric.
  const legacy = Deno.env.get("CODEX_STOP_GUARD_RUBRIC") === "work";
  const questions = await Deno.readTextFile(
    legacy
      ? `${REPO}/jev/questions-mjolnir-work.json`
      : `${REPO}/jev/questions-present-tense-v3.json`,
  );
  // Route through `experiment.run_json` so usage and cost are captured: output tokens are
  // free, so input tokens are the whole cost story. A cached replay is reported as a replay
  // rather than counted as spend. The probe mode derives its synthetic choice against the
  // floor sent in the payload, so the hook and an offline scorer agree on the same rule.
  const script = `
import json, sys
from jev_sandbox import route
route.apply()
from jev_sandbox import experiment
payload = json.loads(sys.stdin.read())
questions = json.loads(payload["questions"])
exp = experiment.run_json(
    {"user_request": payload["request"][:900], "assistant_final": payload["final"][:1200]},
    questions,
)
if payload["mode"] == "work":
    try:
        a = exp.choices["work"]
    except Exception:
        a = exp.nouls["work"]
    out = {
        "choice": getattr(a, "choice", None),
        "confidence": getattr(a, "confidence", None),
        "probabilities": getattr(a, "probabilities", None),
    }
else:
    a = exp.nouls["present_tense_v3"]
    p = float(a.noul)
    out = {
        "choice": "authorized_unfinished" if p >= payload["floor"] else "finished",
        "confidence": p,
        "probabilities": {"authorized_unfinished": p, "finished": 1 - p, "waiting": 0.0, "unclear": 0.0},
    }
out.update({
    "input_tokens": exp.input_tokens,
    "output_tokens": exp.output_tokens,
    "cost_usd": exp.cost_usd,
    "elapsed_ms": exp.elapsed_ms,
    "replayed": bool((exp.cache or {}).get("replayed")),
    "request_id": getattr(exp, "request_id", None),
})
print(json.dumps(out))
`;
  try {
    const proc = new Deno.Command(UV, {
      args: ["run", "python", "-c", script],
      cwd: JEV_REPO,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(JSON.stringify({
        request,
        final,
        questions,
        mode: legacy ? "work" : "probe",
        floor: CONTINUE_MIN_PROBABILITY,
      })),
    );
    await writer.close();
    const { stdout, stderr, code } = await proc.output();
    const out = new TextDecoder().decode(stdout).trim();
    const err = new TextDecoder().decode(stderr).trim();
    const line = out.split("\n").pop() ?? "";
    try {
      return JSON.parse(line);
    } catch {
      // Surface the real failure: a swallowed error here reads as "no signal" and hides a bug.
      return { __error: `exit=${code} stderr_tail=${err.slice(-600)}` };
    }
  } catch (error) {
    return { __error: `spawn failed: ${String(error)}` };
  }
}

async function decide(event: Event): Promise<Decision> {
  if (event.hook_event_name !== "Stop") return { allow: true, reason: "not-stop" };
  // Never continue twice for one turn, and never when the hook is already driving the turn.
  if (event.stop_hook_active === true) return { allow: true, reason: "already-active" };
  const session = event.session_id ?? "";
  const turn = event.turn_id ?? "";
  const transcript = event.transcript_path ?? "";
  if (!session || !turn) return { allow: true, reason: "jev-unavailable" };
  if (!transcript) return { allow: true, reason: "no-transcript" };

  // Deterministic gate: a turn that ended on a tool call is not a stop.
  let facts: ReturnType<typeof factsFor>;
  try {
    facts = factsFor(transcript);
  } catch {
    return { allow: true, reason: "no-transcript" };
  }
  try {
    await recordNoWorkContinuation(session, turn, facts.counts);
  } catch { /* telemetry only; never change a decision */ }
  // The guard exists for non-GPT models: stand down, free, when this turn ran on GPT/OpenAI.
  // An unreadable model leaves the guard on.
  const model = event.model ?? facts.model;
  if (model && /(gpt|openai|codex)|^o[0-9]/i.test(model)) {
    return { allow: true, reason: "model-gpt", evidence: { ...facts, model } };
  }

  if (!facts.gate_ends_without_tool_call) {
    return { allow: true, reason: "tool-call-at-end", evidence: facts };
  }
  // No goal-mode stand-down. Transcripts only ever record `active` at goal creation and
  // never write the status when a goal finishes (checked across every session), so reading
  // goal state from the transcript can only produce a permanent false stand-down. The hook
  // fires on every turn instead.

  if (await allowanceSpent(session, turn)) return { allow: true, reason: "allowance-spent" };

  // jev judges the latest real user request against the final message; read the request from
  // the transcript (the cwd is only a fallback) so the verdict sees the actual authorization.
  let request = event.cwd ? `(cwd: ${event.cwd})` : "";
  let final = event.last_assistant_message ?? "";
  try {
    const texts = textsFor(transcript);
    if (texts.request) request = texts.request;
    if (!final && texts.final) final = texts.final;
  } catch { /* keep the fallbacks */ }
  // Mechanical unfinished-shape receipts plus contradicted completion claims. These catch
  // the claim-vs-truth class a text-only probe reads as completion.
  const textFacts = textReceipts(request, final);
  const claimContradicted = (facts.gate_claim_evidence ?? []).some((c) =>
    c.status === "contradicted"
  );
  const receiptContinue = Object.values(textFacts).some(Boolean);
  const verdict = await judge(request, final);
  if (!verdict || typeof verdict.__error === "string") {
    return { allow: true, reason: "jev-error", evidence: { ...facts, error: verdict?.__error ?? "no verdict" } };
  }

  const choice = String(verdict.choice ?? "");
  // The floor the gate applies and the measured probability it compares against ride in every
  // jev row, so the decision log is self-describing.
  const unfinished = typeof verdict.probabilities?.authorized_unfinished === "number"
    ? verdict.probabilities.authorized_unfinished
    : 0;
  const evidence = {
    ...facts,
    text_receipts: textFacts,
    claim_contradicted: claimContradicted,
    jev: verdict,
    floor: CONTINUE_MIN_PROBABILITY,
    unfinished,
    request_head: request.slice(0, 900),
    final_head: final.slice(0, 1200),
  };
  // Policy: continue when the probe clears its floor, when any mechanical receipt fires,
  // or when a completion claim is contradicted by the turn's own receipts. Supported and
  // unobserved claim states stay diagnostic in the log; only contradiction authorizes action.
  // The probe gate reads the probability jev assigns to authorized_unfinished, not `confidence`:
  // `confidence` is jev's certainty about its own pick and overlaps badly between real stops
  // (0.36-0.94) and false ones, while the option probability separates far better
  // (stopped ~0.59-0.96 against ~0.48-0.55 for the false ones).
  const probeContinue = choice === "authorized_unfinished" &&
    unfinished >= CONTINUE_MIN_PROBABILITY;
  if (probeContinue || receiptContinue || claimContradicted) {
    return { allow: false, reason: "continue", evidence };
  }
  if (choice === "finished") return { allow: true, reason: "decided-finished", evidence };
  if (choice === "waiting") return { allow: true, reason: "decided-waiting", evidence };
  return { allow: true, reason: "decided-unclear", evidence };
}

if (import.meta.main) {
  const raw = await new Response(Deno.stdin.readable).text();
  let event: Event = {};
  try {
    event = JSON.parse(raw) as Event;
  } catch {
    console.log(JSON.stringify({}));
    Deno.exit(0);
  }

  let decision: Decision;
  try {
    decision = await decide(event);
  } catch (error) {
    decision = { allow: true, reason: "jev-unavailable", evidence: { error: String(error) } };
  }

  // Consume the allowance HERE, before any branch can return early. Doing it further down
  // meant an added display path exited first and left the one-continuation rule unenforced.
  if (!decision.allow) {
    try {
      await consumeAllowance(event.session_id ?? "", event.turn_id ?? "", decision.evidence);
    } catch (error) {
      // If the allowance cannot be recorded, the continuation must not happen.
      decision = { allow: true, reason: "jev-unavailable", evidence: { error: String(error) } };
    }
  }

  // One unique id per hook execution: on the visible line, inside any continuation reason
  // (the only text that survives a continuation), in the decision log, and what feedback cites.
  const session = event.session_id ?? "";
  const turn = event.turn_id ?? "";
  const sequence = (await priorExecutions(session, turn)) + 1;
  const id = executionId(session, turn, sequence);

  // Log every decision so the trial can be measured afterwards.
  try {
    await Deno.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      `${STATE_DIR}/decisions.jsonl`,
      JSON.stringify({
        at: new Date().toISOString(),
        id,
        session: event.session_id,
        turn: event.turn_id,
        cwd: event.cwd ?? null,
        transcript: event.transcript_path ?? null,
        decision: decision.reason,
        allowed: decision.allow,
        dry_run: DRY_RUN,
        evidence: decision.evidence,
      }) + "\n",
      { append: true },
    );
  } catch { /* logging must never change a decision */ }

  // GPT/OpenAI sessions stand down silently: no line, no continuation. The decision row above
  // keeps the telemetry.
  if (decision.reason === "model-gpt") {
    console.log(JSON.stringify({}));
    Deno.exit(0);
  }

  // Transparency: every time jev is actually consulted, say so on screen. The free
  // gates above never reach here, so this appears only when a call was paid for.
  // Every decision prints one line. The owner's requirement is to see when jev spends
  // money, and a silent early return is indistinguishable from a broken hook.
  // Measured authorized_unfinished probability over the effective floor, on the visible line.
  const measured = (decision.evidence as { unfinished?: number } | undefined)?.unfinished;
  const score = typeof measured === "number" ? measured.toFixed(2) : "-";
  const floor = CONTINUE_MIN_PROBABILITY.toFixed(2);
  const jev = (decision.evidence as { jev?: Verdict } | undefined)?.jev;
  if (jev) {
    const prior = await sessionSpend(event.session_id ?? "", id);
    const billed = jev.replayed !== true;
    const session_total = {
      calls: prior.calls + (billed ? 1 : 0),
      usd: prior.usd + (billed ? jev.cost_usd ?? 0 : 0),
      cached: prior.cached + (billed ? 0 : 1),
    };
    console.log(JSON.stringify({
      ...(decision.allow ? {} : { decision: "block", reason: continueReason(decision.evidence, id) }),
      systemMessage: `[stop-guard] ${decision.allow ? "no resume" : "resume"} | $${
        session_total.usd.toFixed(6)
      } | ${session_total.calls + session_total.cached} calls | ${score}/${floor} | $stop-guard-feedback ${id}`,
    }));
    Deno.exit(0);
  }

  // No jev call: still print, so silence never has to be interpreted.
  const prior = await sessionSpend(event.session_id ?? "", id);
  console.log(JSON.stringify({
    systemMessage: `[stop-guard] no resume | $${prior.usd.toFixed(6)} | ${
      prior.calls + prior.cached
    } calls | ${score}/${floor} | $stop-guard-feedback ${id}`,
  }));
  Deno.exit(0);
}
