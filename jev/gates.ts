#!/usr/bin/env -S deno run --allow-read
// Belay's mechanical preconditions, read from the transcript rather than judged:
// "The first two are judgments. The other two are facts the extractor reads out of the
// transcript, so they are never labeled by hand or by a model." — jev-belay RUBRIC.md
//
// Reads one Codex transcript (rollout JSONL) and returns the factual gates. No model call.

export interface TurnFacts {
  ok: boolean;
  error?: string;
  gate_ends_without_tool_call: boolean;
  gate_changed_something: boolean;
  gate_fresh_pass_after_last_change: boolean;
  /**
   * The final text claims a concrete completion (committed, pushed, merged, deployed, tests
   * pass, suite green, or a fix verified by re-running) with nothing in the turn to support
   * it: no commit hash in the text, no named mutation, and no fresh passing check after the
   * last change. Diagnostic only; the continuation policy does not read it yet.
   */
  gate_claim_unsupported: boolean;
  /** Completion claims in the final text matched against transcript receipts (diagnostic). */
  gate_claim_evidence: ClaimEvidence[];
  /** Final text says the assistant has not yet performed named work ("I haven't restored…"). */
  gate_unperformed_action: boolean;
  /** Final text states a missing/incomplete artifact ("What is missing…", "not implemented"). */
  gate_explicit_missing: boolean;
  /** Final opens or closes on an in-progress self-action ("Implementing X:", "Verifying …"). */
  gate_in_progress_action: boolean;
  /** Final declares a locked decision ("the choice is now locked") instead of done work. */
  gate_decision_locked: boolean;
  /** The request asks for a fix and the reply is two or more questions with no attempt. */
  gate_questions_without_attempt: boolean;
  /** The turn carries a goal-runner continuation; the goal system owns continuation. */
  gate_goal_context: boolean;
  /** Latest goal status seen in the transcript, or null when the thread has no goal. */
  goal_status: string | null;
  /** Latest model recorded by a turn-context record, or null when absent. */
  model: string | null;
  counts: Record<string, number>;
  last_assistant_text_chars: number;
}

/** Codex writes tool activity as response_item payload.type === "function_call". */
const TOOL_KINDS = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search",
  "mcp_tool_call",
  "patch_apply",
]);

/** Belay's mutation set, widened to the shell paths Codex uses to edit files. */
const MUTATION_RE =
  /apply_patch|\bpatch\b|\bedit\b|str_replace|create_file|write_file|>\s*\S|tee\s/i;

/** A check counts as passed only when its output shows success and no failure. */
const PASS_RE =
  /(\d+\s+passed|tests?\s+passed|test result:\s*ok\b|verify:\s*OK\b|0\s+failed|✓)/i;
const FAIL_RE =
  /(\d+\s+failed|test result:\s*FAILED|\bFAILED\b|\berror:|\bexit code [1-9])/i;
/** Concrete completion claims a final message can make about its own turn. */
const CLAIM_RE =
  /(committed|pushed|merged|deployed|all \d+ (tests|checks) pass|tests? pass|suite (is )?green|re-?running it fixed)/i;
/** Negation, quotation, and fixture context: a disclaimed claim is not a claim. */
const CLAIM_NEG_RE =
  /(\bnot\b|\bnever\b|\bno\b|\bnothing\b|\bfixture\b|\bcanned\b|\bcounterfeit\b|\bfalse\b)/i;
/** A commit-hash-shaped token counts as in-text evidence for a completion claim. */
const COMMIT_HASH_RE = /\b[0-9a-f]{7,40}\b/;

interface Item {
  type?: string;
  role?: string;
  name?: string;
  text?: string;
  content?: unknown[];
  output?: unknown;
  aggregated_output?: unknown;
  stdout?: unknown;
  formatted_output?: unknown;
  arguments?: string;
  call_id?: string;
  model?: unknown;
}

function loadItems(path: string): Item[] {
  const items: Item[] = [];
  for (const line of Deno.readTextFileSync(path).split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record.payload;
    if (payload && typeof payload === "object") items.push(payload as Item);
  }
  return items;
}

function toolName(item: Item): string | undefined {
  if (!item.type || !TOOL_KINDS.has(item.type)) return undefined;
  return typeof item.name === "string" ? item.name : item.type;
}

function outputText(item: Item): string {
  for (
    const value of [
      item.output,
      item.aggregated_output,
      item.stdout,
      item.formatted_output,
    ]
  ) {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value)) {
      const text = value
        .filter((c): c is Record<string, unknown> =>
          !!c && typeof c === "object"
        )
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      if (text) return text;
    }
  }
  return "";
}

/** The message text of a transcript item, from whichever field Codex used. */
function messageText(item: Item): string {
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) {
    return item.content
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

function assistantTextLength(item: Item): number {
  if (item.type !== "message" || item.role !== "assistant") return 0;
  return messageText(item).length;
}

interface MessageRecord {
  recordType: string;
  timestamp?: string;
  role?: string;
  text: string;
  turnId?: string | null;
}

/** Message and turn-boundary records, carrying the record timestamp and turn linkage. */
function loadMessageRecords(path: string): MessageRecord[] {
  const records: MessageRecord[] = [];
  for (const line of Deno.readTextFileSync(path).split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const recordType = typeof record.type === "string" ? record.type : "";
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;
    const timestamp = typeof record.timestamp === "string"
      ? record.timestamp
      : undefined;
    if (recordType === "turn_context") {
      records.push({
        recordType,
        timestamp,
        text: "",
        turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
      });
      continue;
    }
    if (payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const passthrough = payload.internal_chat_message_metadata_passthrough as
      | { turn_id?: unknown }
      | undefined;
    records.push({
      recordType,
      timestamp,
      role,
      text: messageText(payload as unknown as Item),
      turnId: typeof passthrough?.turn_id === "string"
        ? passthrough.turn_id
        : null,
    });
  }
  return records;
}

/**
 * Best-effort last human request and last assistant message, for feedback examples.
 * `opts` scopes the read to one turn (`turnId`) and decision moment (`stopAt`), so a stop
 * that recorded no captured heads still resolves to the texts the hook would have judged.
 * Without `opts` the read is unchanged: the latest request and final message in the file.
 */
export function textsFor(
  path: string,
  opts?: { turnId?: string | null; stopAt?: string | null },
): { request: string; final: string } {
  const turn = opts?.turnId ?? null;
  const stopAt = opts?.stopAt ?? null;
  let currentTurn: string | null = null;
  let request = "";
  let final = "";
  for (const record of loadMessageRecords(path)) {
    if (record.recordType === "turn_context") {
      currentTurn = record.turnId ?? null;
      continue;
    }
    const itemTurn = record.turnId ?? currentTurn;
    if (turn && itemTurn && itemTurn !== turn) continue;
    if (stopAt && record.timestamp && record.timestamp > stopAt) continue;
    if (!record.text) continue;
    // Skip injected context blocks (<environment_context>, <hook_prompt>, ...).
    if (record.role === "user" && !record.text.trimStart().startsWith("<")) {
      request = record.text;
    } else if (record.role === "assistant") final = record.text;
  }
  return { request, final };
}

// --- Claim receipts: match completion claims to transcript evidence ----------

export interface CommandReceipt {
  name: string;
  command: string;
  passed: boolean;
  failed: boolean;
  isCheck: boolean;
  commit: boolean;
  push: boolean;
  merge: boolean;
  deploy: boolean;
  mutating: boolean;
  job: boolean;
  /** File targets touched by this call (patch headers, redirects, tee). */
  targets: string[];
  /** Captured output, capped; used by claim-token evidence. */
  output: string;
}

export interface ClaimEvidence {
  claim: string;
  status: "supported" | "contradicted" | "unobserved";
  detail: string;
}

const CHECK_COMMAND_RE =
  /\b(deno|npm|pnpm|yarn|bun|cargo|go|pytest|uv|python3?|npx|node|tsc|eslint|prettier|make)\b[^\n]{0,140}\b(test|lint|fmt|format|check|verify|build|tsc|typecheck)\b|\b(run the (?:full )?(?:tests?|suite|checks?|gate)|test suite|verify gate|full gate)\b/i;
const COMMIT_COMMAND_RE = /\bgit\b[^\n]*\bcommit\b/i;
const PUSH_COMMAND_RE = /\bgit\b[^\n]*\bpush\b/i;
const MERGE_COMMAND_RE = /\bgit\b[^\n]*\bmerge\b|\bgh\b[^\n]*\bmerge\b/i;
const DEPLOY_COMMAND_RE = /\bdeploy\b|\bworkflow run\b|\bsystemctl\b/i;
/** Background-job family tool calls: waiting claims must point at one of these. */
const JOB_CALL_RE =
  /^(?:wait|wait_agent|spawn_agent|followup_task|write_stdin|resume_agent)$/;
const COMMAND_MUTATION_RE =
  /(apply_patch|\bgit\b[^\n]*\b(?:commit|merge|rebase|reset|checkout|restore|mv|rm|apply)\b|\bsed -i\b|\btee\s)/i;

/** Pure classifier: one tool call becomes one receipt. */
export function classifyCommand(
  name: string,
  command: string,
  output: string,
): CommandReceipt {
  const passed = PASS_RE.test(output) && !FAIL_RE.test(output);
  const failed = FAIL_RE.test(output) && !passed;
  return {
    name,
    command,
    passed,
    failed,
    isCheck: CHECK_COMMAND_RE.test(command) || CHECK_COMMAND_RE.test(name),
    commit: COMMIT_COMMAND_RE.test(command),
    push: PUSH_COMMAND_RE.test(command),
    merge: MERGE_COMMAND_RE.test(command),
    deploy: DEPLOY_COMMAND_RE.test(command),
    mutating: MUTATION_RE.test(name) || COMMAND_MUTATION_RE.test(command),
    job: JOB_CALL_RE.test(name),
    targets: fileTargetsOf(command),
    output: output.slice(0, 1200),
  };
}

/** File targets a tool call touches: patch headers, redirects, and tee. */
function fileTargetsOf(command: string): string[] {
  const out = new Set<string>();
  for (
    const m of command.matchAll(
      /\*\*\* (?:Update|Add|Delete) File:\s*([^\s]+)/g,
    )
  ) out.add(m[1]);
  for (
    const m of command.matchAll(/(?:^|[^0-9&>])>>?\s*(?!&|\d)([^\s"'`|&]+)/g)
  ) out.add(m[1]);
  for (const m of command.matchAll(/\btee\s+([^\s"'`|&]+)/g)) out.add(m[1]);
  return [...out];
}

/** First file-like token in a claim window, when the claim names a target. */
function claimFileToken(window: string): string | null {
  const m = /([A-Za-z0-9_./-]+\.(?:ts|tsx|py|md|json|js|jsx|sh|sql))\b/.exec(
    window,
  );
  return m ? m[1] : null;
}

/** Read-only gathering commands: an echo from these is weaker than a run/verify. */
const READ_COMMAND_RE =
  /^\s*(cat|head|tail|sed|less|more|bat|ls|stat|find|read)\b/;

/** The object of the behavior phrase — a quoted token after it, or a bare hyphenated token. */
function claimToken(phraseStart: string): string | null {
  const quoted = /`([A-Za-z0-9_.-]{3,64})`|"([A-Za-z0-9_.-]{3,64})"/.exec(
    phraseStart,
  );
  if (quoted) return quoted[1] ?? quoted[2];
  const bare =
    /(?:logged as|enabled|wired in|takes effect|auto-?records)\s+(?:as\s+)?([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+)/i
      .exec(phraseStart);
  return bare ? bare[1] : null;
}

/** The command text of a tool call, parsed from its arguments when possible. */
function commandTextOf(item: Item): string {
  const raw = typeof item.arguments === "string" ? item.arguments : "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { cmd?: unknown; command?: unknown };
    if (typeof parsed.cmd === "string") return parsed.cmd;
    if (typeof parsed.command === "string") return parsed.command;
  } catch { /* raw arguments text */ }
  return raw;
}

/** Claim patterns in the final text, with the negation window guard applied by the caller. */
const FINAL_CLAIMS: Array<[string, RegExp]> = [
  ["commit", /\bcommitted\b/i],
  ["push", /\bpushed\b/i],
  ["merge", /\bmerged\b/i],
  ["deploy", /\bdeployed\b/i],
  [
    "tests-pass",
    /\b(tests? (all )?pass\w*|all \d+ (tests|checks) pass\w*|suite (is )?green|verify:?\s*ok\b|lint (?:is|now)\b[^\n]{0,20}\bclean\b)/i,
  ],
  [
    "rerun-fixed",
    /\bre-?r(?:an|unning|un)\b[^\n]{0,60}\b(fixed|passed|works|green)\b/i,
  ],
  [
    "behavior-claim",
    /\b(logged as|auto-?records|is now enabled|now enabled|wired in|takes effect)\b/i,
  ],
  ["waiting", /\b(waiting (?:for|on)|holding for)\b/i],
];

/**
 * Match each completion claim in the final text to transcript receipts.
 * `supported` = a matching receipt exists; `contradicted` = in-turn evidence disproves the claim
 * (a claimed rerun with no captured check command, or post-change checks with no passing result);
 * `unobserved` = no evidence either way. Contradiction never authorizes an action by itself.
 */
export function claimEvidenceFor(
  finalText: string,
  receipts: CommandReceipt[],
): ClaimEvidence[] {
  const out: ClaimEvidence[] = [];
  for (const [claim, re] of FINAL_CLAIMS) {
    const m = re.exec(finalText);
    if (!m) continue;
    const window = finalText.slice(
      Math.max(0, m.index - 60),
      m.index + m[0].length + 60,
    );
    if (CLAIM_NEG_RE.test(window)) continue;
    const forward = finalText.slice(m.index, m.index + m[0].length + 100);
    let status: ClaimEvidence["status"] = "unobserved";
    let detail = "no matching receipt in the turn";
    if (
      claim === "commit" || claim === "push" || claim === "merge" ||
      claim === "deploy"
    ) {
      const hit = receipts.some((r) =>
        r[claim as "commit" | "push" | "merge" | "deploy"]
      );
      if (hit) {
        status = "supported";
        detail = `${claim} command ran in the turn`;
      }
    } else if (claim === "tests-pass") {
      const lastMut = receipts.reduce(
        (acc, r, i) => (r.mutating ? i : acc),
        -1,
      );
      const post = receipts.slice(lastMut + 1).filter((r) => r.isCheck);
      if (post.some((r) => r.passed)) {
        status = "supported";
        const file = claimFileToken(forward);
        if (file) {
          const touched = receipts.some((r) =>
            r.targets.some((t) => t === file || t.endsWith(`/${file}`))
          );
          const checked = post.some((r) =>
            r.passed && r.command.includes(file)
          );
          if (!touched && !checked) {
            status = "unobserved";
            detail = `a fresh pass exists but no receipt touches ${file}`;
          } else {
            detail = `a check passed after the last change (scope: ${file})`;
          }
        } else {
          detail = "a check passed after the last change";
        }
      } else if (post.length > 0) {
        status = "contradicted";
        detail = "checks ran after the last change without a passing result";
      }
    } else if (claim === "behavior-claim") {
      const token = claimToken(forward);
      if (token) {
        const checked = receipts.filter((r) =>
          r.output.includes(token) && r.command.includes(token) &&
          !READ_COMMAND_RE.test(r.command)
        );
        const echoed = receipts.filter((r) => r.output.includes(token));
        if (checked.length > 0) {
          status = "supported";
          detail = `token ${token} explicitly checked in an in-turn command`;
        } else if (echoed.length > 0) {
          status = "unobserved";
          detail =
            `token ${token} echoed in output but never explicitly checked`;
        } else {
          status = "unobserved";
          detail = `claim token ${token} never observed in any tool output`;
        }
      } else {
        status = "unobserved";
        detail =
          "runtime behavior claim; no state receipt available in the turn record";
      }
    } else if (claim === "waiting") {
      const job = receipts.find((r) => r.job);
      if (job) {
        status = "supported";
        detail = `background-job call captured: ${job.name}`;
      } else {
        status = "unobserved";
        detail = "claims waiting; no background-job call captured";
      }
    } else if (claim === "rerun-fixed") {
      const checks = receipts.filter((r) => r.isCheck);
      if (checks.length === 0) {
        status = "contradicted";
        detail =
          "claims an in-turn re-run and fix; no check command was captured";
      } else {
        const lastMut = receipts.reduce(
          (acc, r, i) => (r.mutating ? i : acc),
          -1,
        );
        const post = receipts.slice(lastMut + 1).filter((r) => r.isCheck);
        if (post.some((r) => r.passed)) {
          status = "supported";
          const file = claimFileToken(forward);
          if (file) {
            const touched = receipts.some((r) =>
              r.targets.some((t) => t === file || t.endsWith(`/${file}`))
            );
            const checked = post.some((r) =>
              r.passed && r.command.includes(file)
            );
            if (!touched && !checked) {
              status = "unobserved";
              detail = `a re-run passed but no receipt touches ${file}`;
            } else {
              detail = `a re-run passed after the last change (scope: ${file})`;
            }
          } else {
            detail = "a re-run passed after the last change";
          }
        } else if (post.length > 0) {
          status = "contradicted";
          detail = "the latest checks after the change did not pass";
        }
      }
    }
    out.push({ claim, status, detail });
  }
  return out;
}

/** A concrete completion claim in `text` that carries no commit-hash evidence of its own. */
function unsupportedClaim(text: string): boolean {
  const re = new RegExp(CLAIM_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const window = text.slice(
      Math.max(0, match.index - 60),
      match.index + match[0].length + 60,
    );
    if (CLAIM_NEG_RE.test(window)) continue;
    return !COMMIT_HASH_RE.test(text);
  }
  return false;
}

// --- Text receipts: unfinished shapes a language-only probe reads as completion ------

/** Mechanical unfinished-shape receipts read from the decision-time request/final text. */
export interface TextReceipts {
  gate_unperformed_action: boolean;
  gate_explicit_missing: boolean;
  gate_in_progress_action: boolean;
  gate_decision_locked: boolean;
  gate_questions_without_attempt: boolean;
}

const APOS = "[\u2019']";
const GERUND =
  "(?:Verifying|Checking|Investigating|Implementing|Doing|Running|Testing|Building|Adding|Wiring|Recording|Preparing|Extending|Updating|Fixing|Patching|Writing|Working on|Reviewing|Auditing|Probing|Measuring|Comparing|Gathering|Collecting|Refactoring|Reworking|Tuning|Deploying|Pushing|Committing|Merging|Restarting|Rerunning|Re-running|Inspecting|Scanning|Contracting|Aligning|Correcting|Repairing|Drafting|Assembling|Finalizing|Scheduling|Rendering|Migrating|Installing|Configuring|Debugging|Tracing|Analyzing|Evaluating|Recovering|Reproducing)";
const UNPERFORMED_RE = new RegExp(
  `\\bI (?:haven${APOS}?t|have not|didn${APOS}?t|did not|wasn${APOS}?t|was not)(?:\\s+yet)?(?:\\s+\\w+)?\\s+(?:restored|changed|restarted|updated|implemented|fixed|tested|verified|checked|ran|run|completed|finished|started|deployed|committed|pushed|established|created|written|built|produced|confirmed|recovered|saved|migrated|installed|configured)\\b`,
  "i",
);
const EXPLICIT_MISSING_RE = new RegExp(
  "(?:\\bwhat(?:[\u2019']s| is) missing (?:is|are)\\b|\\bdoes not (?:yet )?reproduce\\b|\\bnot (?:yet )?(?:implemented|done|finished|ready|reproduced)\\b(?!,? by design))",
  "i",
);
const IN_PROGRESS_OPEN_RE = new RegExp(
  `(?:^|[.!?]\\s|\\n)\\s*${GERUND}\\b[^.!?\\n]{0,120}:`,
  "i",
);
const IN_PROGRESS_START_RE = new RegExp(`^\\s*(?:Now\\s+)?${GERUND}\\b`, "i");
const IN_PROGRESS_END_RE = new RegExp(
  `(?:^|[.!?]\\s|\\n)\\s*${GERUND}\\b[^.!?\\n]{0,160}\\.?\\s*$`,
  "i",
);
const DECISION_LOCKED_RE = /\b(?:is|are)\s+(?:now\s+)?locked\b/i;
const FIX_REQUEST_RE =
  /\b(?:fix|solve|debug|repair|investigate|look into|figure out)\b/i;
const FIRST_PERSON_RE = /\bI(?:[\u2019'](?:ll|m|ve)|\s+(?:will|have|am))\b/i;

/** Remove quoted/code spans so a report that quotes an example is not read as its own claim.
 *  Backticks are stripped first so a quote nested inside a code span goes with it. */
function stripQuoted(text: string): string {
  return text
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/\u201C[^\u201D]*\u201D/g, " ");
}

/** True when the pattern matches outside a quoted/code context. */
function unquotedMatch(re: RegExp, text: string): boolean {
  return re.test(stripQuoted(text));
}

/** Read the mechanical unfinished-shape receipts from the decision-time texts. */
export function textReceipts(request: string, final: string): TextReceipts {
  return {
    gate_unperformed_action: unquotedMatch(UNPERFORMED_RE, final),
    gate_explicit_missing: unquotedMatch(EXPLICIT_MISSING_RE, final),
    gate_in_progress_action: unquotedMatch(IN_PROGRESS_OPEN_RE, final) ||
      unquotedMatch(IN_PROGRESS_START_RE, final) ||
      unquotedMatch(IN_PROGRESS_END_RE, final),
    gate_decision_locked: unquotedMatch(DECISION_LOCKED_RE, final),
    gate_questions_without_attempt: (final.match(/\?/g)?.length ?? 0) >= 2 &&
      FIX_REQUEST_RE.test(request) && !FIRST_PERSON_RE.test(final),
  };
}

export function factsFor(path: string): TurnFacts {
  const items = loadItems(path);
  const counts: Record<string, number> = {};
  let lastMutationIndex = -1;

  items.forEach((item, index) => {
    const name = toolName(item);
    if (name === undefined) return;
    const key = name.split(/\s+/)[0];
    counts[key] = (counts[key] ?? 0) + 1;
    if (MUTATION_RE.test(name)) lastMutationIndex = index;
  });

  // A check counts only when it ran after the last change.
  const freshPass: string[] = [];
  items.forEach((item, index) => {
    const name = toolName(item);
    if (name === undefined || index <= lastMutationIndex) return;
    const output = outputText(item);
    if (output && PASS_RE.test(output) && !FAIL_RE.test(output)) {
      freshPass.push(name.slice(0, 80));
    }
  });

  // Goal mode continues the thread on its own. Read the goal status from the LAST genuine
  // thread_goal_updated record only: matching on the string, or on a bare `goal` key, also
  // catches ordinary messages and tool calls that merely mention goals.
  let goalStatus: string | null = null;
  for (const item of items) {
    const record = item as {
      type?: string;
      goal?: { status?: unknown };
      payload?: { type?: string; goal?: { status?: unknown } };
    };
    const isGoalRecord = record.type === "thread_goal_updated" ||
      record.payload?.type === "thread_goal_updated";
    if (!isGoalRecord) continue;
    const status = record.goal?.status ?? record.payload?.goal?.status;
    if (typeof status === "string") goalStatus = status;
  }

  // The latest turn-context record carries the model the current turn ran on.
  let model: string | null = null;
  for (const item of items) {
    if (typeof item.model === "string" && item.model) model = item.model;
  }

  const outputsByCall = new Map<string, string>();
  for (const item of items) {
    if (item.type === "function_call_output" && item.call_id) {
      outputsByCall.set(item.call_id, outputText(item));
    }
  }
  const receipts = items
    .filter((item) => toolName(item) !== undefined)
    .map((item) => {
      const output = outputText(item) ||
        (item.call_id ? outputsByCall.get(item.call_id) ?? "" : "");
      return classifyCommand(toolName(item) ?? "", commandTextOf(item), output);
    });

  const texts = textsFor(path);
  const textFacts = textReceipts(texts.request, texts.final);

  const lastAssistantIndex = items.reduce(
    (acc, item, index) => (assistantTextLength(item) > 0 ? index : acc),
    -1,
  );
  const toolAfterLastText = items.some(
    (item, index) => index > lastAssistantIndex && toolName(item) !== undefined,
  );

  return {
    ok: true,
    ...textFacts,
    gate_ends_without_tool_call: lastAssistantIndex >= 0 && !toolAfterLastText,
    gate_changed_something: lastMutationIndex >= 0,
    gate_fresh_pass_after_last_change: freshPass.length > 0,
    gate_claim_unsupported: lastAssistantIndex >= 0 &&
      unsupportedClaim(messageText(items[lastAssistantIndex])) &&
      lastMutationIndex < 0 &&
      freshPass.length === 0,
    gate_claim_evidence: lastAssistantIndex >= 0
      ? claimEvidenceFor(messageText(items[lastAssistantIndex]), receipts)
      : [],
    gate_goal_context: items.some((item) =>
      item.type === "message" && item.role === "user" &&
      messageText(item).includes('codex_internal_context source="goal"')
    ),
    goal_status: goalStatus,
    model,
    counts,
    last_assistant_text_chars: lastAssistantIndex >= 0
      ? assistantTextLength(items[lastAssistantIndex])
      : 0,
  };
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    console.error("usage: gates.ts <transcript.jsonl>");
    Deno.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(factsFor(path), null, 2));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error) }, null, 2));
      Deno.exitCode = 1;
    }
  }
}
