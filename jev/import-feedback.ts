#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Fold the labelled feedback log into the offline corpus shape for scoring.
//
//   deno run --allow-read --allow-write --allow-env jev/import-feedback.ts
//
// Reads $CODEX_STOP_GUARD_DIR/feedback.jsonl (or ~/.local/state/codex-stop-guard) and
// rewrites jev/feedback-corpus.jsonl: one row per execution id in corpus.jsonl's shape
// (user_request, assistant_final, label), plus the feedback metadata. A manual label wins
// over an automatic `suspected_false_positive` entry for the same id.
const DIR = Deno.env.get("CODEX_STOP_GUARD_DIR") ??
  `${Deno.env.get("HOME")}/.local/state/codex-stop-guard`;
const OUT = new URL("./feedback-corpus.jsonl", import.meta.url);

interface Entry {
  at?: string;
  id?: string;
  session?: string;
  turn?: string;
  hook_decision?: string;
  expected?: string | null;
  agree?: boolean;
  auto?: boolean;
  suspected_false_positive?: boolean;
  note?: string;
  request?: string;
  final?: string;
}

let text = "";
try {
  text = await Deno.readTextFile(`${DIR}/feedback.jsonl`);
} catch {
  console.error(`no feedback log at ${DIR}/feedback.jsonl`);
  Deno.exit(1);
}
const entries: Entry[] = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  try {
    entries.push(JSON.parse(line) as Entry);
  } catch { /* skip a torn line */ }
}
// One row per execution id: a manual label wins over an automatic suspicion.
const byId = new Map<string, Entry>();
const ordered: Entry[] = [];
for (const entry of entries) {
  if (!entry.id) {
    ordered.push(entry);
    continue;
  }
  const existing = byId.get(entry.id);
  if (!existing) {
    byId.set(entry.id, entry);
    ordered.push(entry);
    continue;
  }
  if (existing.auto === true && entry.auto !== true) {
    ordered[ordered.indexOf(existing)] = entry;
    byId.set(entry.id, entry);
  }
}
let stops = 0;
let done = 0;
let autos = 0;
const rows = ordered.map((entry) => {
  const label = entry.expected === "authorized_unfinished" ? "stop" : "done";
  if (label === "stop") stops += 1;
  else done += 1;
  if (entry.auto === true) autos += 1;
  return {
    session: entry.session ?? null,
    turn: entry.turn ?? null,
    label,
    expected: entry.expected ?? null,
    hook_decision: entry.hook_decision ?? null,
    id: entry.id ?? null,
    at: entry.at ?? null,
    auto: entry.auto === true,
    suspected_false_positive: entry.suspected_false_positive === true,
    note: entry.note ?? "",
    user_request: entry.request ?? "",
    assistant_final: entry.final ?? "",
  };
});
await Deno.writeTextFile(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(
  `feedback-corpus.jsonl: ${rows.length} rows (${stops} stop / ${done} done; ${autos} auto) -> ${OUT.pathname}`,
);
