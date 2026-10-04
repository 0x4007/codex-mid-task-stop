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
const MUTATION_RE = /apply_patch|\bpatch\b|\bedit\b|str_replace|create_file|write_file|>\s*\S|tee\s/i;

/** A check counts as passed only when its output shows success and no failure. */
const PASS_RE = /(\d+\s+passed|tests?\s+passed|test result:\s*ok\b|verify:\s*OK\b|0\s+failed|✓)/i;
const FAIL_RE = /(\d+\s+failed|test result:\s*FAILED|\bFAILED\b|\berror:|\bexit code [1-9])/i;

interface Item {
  type?: string;
  role?: string;
  name?: string;
  text?: string;
  content?: unknown[];
  output?: string;
  aggregated_output?: string;
  stdout?: string;
  formatted_output?: string;
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
  for (const value of [item.output, item.aggregated_output, item.stdout, item.formatted_output]) {
    if (typeof value === "string" && value) return value;
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

/** Best-effort last human request and last assistant message, for feedback examples. */
export function textsFor(path: string): { request: string; final: string } {
  const items = loadItems(path);
  let request = "";
  let final = "";
  for (const item of items) {
    if (item.type !== "message") continue;
    const text = messageText(item);
    if (!text) continue;
    // Skip injected context blocks (<environment_context>, <hook_prompt>, ...).
    if (item.role === "user" && !text.trimStart().startsWith("<")) request = text;
    else if (item.role === "assistant") final = text;
  }
  return { request, final };
}

export function factsFor(path: string): TurnFacts {
  const items = loadItems(path);
  const counts: Record<string, number> = {};
  let lastToolIndex = -1;
  let lastMutationIndex = -1;

  items.forEach((item, index) => {
    const name = toolName(item);
    if (name === undefined) return;
    const key = name.split(/\s+/)[0];
    counts[key] = (counts[key] ?? 0) + 1;
    lastToolIndex = index;
    if (MUTATION_RE.test(name)) lastMutationIndex = index;
  });

  // A check counts only when it ran after the last change.
  const freshPass: string[] = [];
  items.forEach((item, index) => {
    const name = toolName(item);
    if (name === undefined || index <= lastMutationIndex) return;
    const output = outputText(item);
    if (output && PASS_RE.test(output) && !FAIL_RE.test(output)) freshPass.push(name.slice(0, 80));
  });

  // Goal mode continues the thread on its own. Read the goal status from the LAST genuine
  // thread_goal_updated record only: matching on the string, or on a bare `goal` key, also
  // catches ordinary messages and tool calls that merely mention goals.
  let goalStatus: string | null = null;
  for (const item of items) {
    const record = item as { type?: string; goal?: { status?: unknown }; payload?: { type?: string; goal?: { status?: unknown } } };
    const isGoalRecord = record.type === "thread_goal_updated" || record.payload?.type === "thread_goal_updated";
    if (!isGoalRecord) continue;
    const status = record.goal?.status ?? record.payload?.goal?.status;
    if (typeof status === "string") goalStatus = status;
  }

  // The latest turn-context record carries the model the current turn ran on.
  let model: string | null = null;
  for (const item of items) {
    if (typeof item.model === "string" && item.model) model = item.model;
  }

  const lastAssistantIndex = items.reduce(
    (acc, item, index) => (assistantTextLength(item) > 0 ? index : acc),
    -1,
  );
  const toolAfterLastText = items.some(
    (item, index) => index > lastAssistantIndex && toolName(item) !== undefined,
  );

  return {
    ok: true,
    gate_ends_without_tool_call: lastAssistantIndex >= 0 && !toolAfterLastText,
    gate_changed_something: lastMutationIndex >= 0,
    gate_fresh_pass_after_last_change: freshPass.length > 0,
    goal_status: goalStatus,
    model,
    counts,
    last_assistant_text_chars: lastAssistantIndex >= 0 ? assistantTextLength(items[lastAssistantIndex]) : 0,
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
