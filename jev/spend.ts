#!/usr/bin/env -S deno run --allow-read --allow-env
// Running jev spend for the Stop guard.
//
// Output tokens are free on this route, so input tokens are the whole cost story
// (jev-sandbox client.estimate_cost_usd). Cached replays are excluded from spend.
//
// Usage:
//   deno run --allow-read --allow-env jev/spend.ts            # all time
//   deno run --allow-read --allow-env jev/spend.ts --today    # since local midnight
//   deno run --allow-read --allow-env jev/spend.ts --json

const DIR = Deno.env.get("CODEX_STOP_GUARD_DIR") ??
  `${Deno.env.get("HOME")}/.local/state/codex-stop-guard`;

interface Row {
  at?: string;
  decision?: string;
  session?: string;
  evidence?: {
    jev?: {
      choice?: string;
      confidence?: number;
      cost_usd?: number | null;
      input_tokens?: number | null;
      replayed?: boolean;
    };
  };
}

function load(): Row[] {
  let text = "";
  try {
    text = Deno.readTextFileSync(`${DIR}/decisions.jsonl`);
  } catch {
    return [];
  }
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch { /* skip a torn line */ }
  }
  return rows;
}

interface SessionSpend {
  session: string;
  calls: number;
  input_tokens: number;
  spend_usd: number;
  continuations: number;
}

/** Spend grouped by session, largest first. */
function bySession(rows: Row[]): SessionSpend[] {
  const map = new Map<string, SessionSpend>();
  for (const row of rows) {
    const jev = row.evidence?.jev;
    if (!jev) continue;
    const key = row.session ?? "(unknown)";
    const entry = map.get(key) ?? { session: key, calls: 0, input_tokens: 0, spend_usd: 0, continuations: 0 };
    entry.calls += 1;
    entry.input_tokens += jev.replayed === true ? 0 : jev.input_tokens ?? 0;
    entry.spend_usd += jev.replayed === true ? 0 : jev.cost_usd ?? 0;
    if (row.decision === "continue") entry.continuations += 1;
    map.set(key, entry);
  }
  return [...map.values()]
    .map((e) => ({ ...e, spend_usd: Number(e.spend_usd.toFixed(8)) }))
    .sort((a, b) => b.spend_usd - a.spend_usd);
}

function summarize(rows: Row[]) {
  const calls = rows.filter((r) => r.evidence?.jev);
  const billed = calls.filter((r) => r.evidence?.jev?.replayed !== true);
  const spend = billed.reduce((s, r) => s + (r.evidence?.jev?.cost_usd ?? 0), 0);
  const tokens = billed.reduce((s, r) => s + (r.evidence?.jev?.input_tokens ?? 0), 0);
  return {
    decisions: rows.length,
    jev_calls: calls.length,
    billed: billed.length,
    replayed: calls.length - billed.length,
    input_tokens: tokens,
    spend_usd: Number(spend.toFixed(8)),
    per_call_usd: billed.length ? Number((spend / billed.length).toFixed(8)) : null,
    continuations: rows.filter((r) => r.decision === "continue").length,
    errors: rows.filter((r) => r.decision === "jev-error").length,
  };
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  let rows = load();

  if (args.has("--today")) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    rows = rows.filter((r) => r.at && Date.parse(r.at) >= midnight.getTime());
  }

  const total = summarize(rows);

  const sessions = bySession(rows);

  if (args.has("--json")) {
    console.log(JSON.stringify({ ...total, sessions }, null, 2));
    Deno.exit(0);
  }

  const usd = (n: number) => `$${n.toFixed(6)}`;
  console.log(
    [
      `TOTAL  ${usd(total.spend_usd)}  ·  ${total.jev_calls} calls  ·  ${
        total.input_tokens.toLocaleString()
      } input tokens  ·  ${total.continuations} continuations`,
      "",
      "PER SESSION",
    ].join("\n"),
  );
  const width = Math.max(7, ...sessions.map((s) => s.session.length));
  for (const s of sessions) {
    console.log(
      `  ${s.session.slice(0, 12).padEnd(14)} ${usd(s.spend_usd)}  ${
        String(s.calls).padStart(3)
      } calls  ${String(s.continuations).padStart(2)} cont  ${s.input_tokens.toLocaleString()} tok`,
    );
  }
}
