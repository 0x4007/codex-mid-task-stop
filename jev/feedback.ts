#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Record a labelled example for one stop-guard hook execution.
//
//   deno run --allow-read --allow-write --allow-env jev/feedback.ts <expected> [--note TEXT] [--id SG_ID] [--session UUID]
//   deno run --allow-read --allow-write --allow-env jev/feedback.ts --list [N]
//
// <expected> is what the hook should have decided: unfinished | finished | waiting | unclear.
// Without --id it uses the most recent execution for $CODEX_THREAD_ID.
import { textsFor } from "./gates.ts";

const DIR = Deno.env.get("CODEX_STOP_GUARD_DIR") ??
  `${Deno.env.get("HOME")}/.local/state/codex-stop-guard`;

const ALIASES: Record<string, string> = {
  unfinished: "authorized_unfinished",
  authorized_unfinished: "authorized_unfinished",
  finished: "finished",
  waiting: "waiting",
  unclear: "unclear",
};

interface Row {
  at?: string;
  id?: string;
  session?: string;
  turn?: string;
  decision?: string;
  cwd?: string | null;
  transcript?: string | null;
  evidence?: {
    request_head?: string;
    final_head?: string;
    jev?: {
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
      cost_usd?: number;
      input_tokens?: number;
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
      rows.push(JSON.parse(line) as Row);
    } catch { /* skip a torn line */ }
  }
  return rows;
}

function usage(): never {
  console.error(
    "usage: feedback.ts [<unfinished|finished|waiting|unclear>] [--note TEXT] [--id SG_ID] [--session UUID]\n" +
      "       feedback.ts <SG_ID> [<verdict>] [--note TEXT]   (verdict defaults to unfinished)\n" +
      "       feedback.ts --list [N]",
  );
  Deno.exit(2);
}

if (import.meta.main) {
  const args = Deno.args;
  const rows = load();
  const envSession = Deno.env.get("CODEX_THREAD_ID") ?? "";

  if (args[0] === "--list") {
    const n = Number(args[1] ?? 5);
    const mine = rows.filter((r) => !envSession || r.session === envSession);
    for (const r of mine.slice(-n)) {
      console.log(
        `${r.at}  ${r.id ?? "?"}  ${r.decision ?? "?"}${
          r.evidence?.jev ? `  ${r.evidence.jev.choice} ${r.evidence.jev.confidence}` : ""
        }`,
      );
    }
    if (!mine.length) {
      console.log(
        envSession
          ? `no executions logged for session ${envSession}`
          : "no executions logged; pass --session or --id",
      );
    }
    Deno.exit(0);
  }

  // The guard line prints `$stop-guard-feedback <id> <verdict>`; accept the verdict and the id
  // in either order. Flags are read first and win over a positional duplicate.
  let expected = "";
  let note = "";
  let id = "";
  let explicitSession = "";
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--note") note = args[++i] ?? "";
    else if (token === "--id") id = args[++i] ?? "";
    else if (token === "--session") explicitSession = args[++i] ?? "";
    else if (!expected && ALIASES[token.trim().toLowerCase()]) expected = ALIASES[token.trim().toLowerCase()];
    else if (/^sg[._]/.test(token) && !id) id = token;
    else usage();
  }
  // If no verdict is given, feedback means the guard missed remaining work.
  if (!expected) {
    if (!args.length) usage();
    expected = "authorized_unfinished";
  }

  let row: Row | undefined;
  if (id) {
    // Accept the underscore form and the older dotted ids (dots normalize to underscores).
    const canon = (v: string) => v.replace(/^sg[._]/, "").replace(/\./g, "_");
    const wanted = canon(id);
    const matches = rows.filter((r) => {
      const rid = canon(r.id ?? "");
      return rid === wanted || rid.startsWith(wanted + "_");
    });
    // An exact id wins; a bare session/turn prefix lists the newest match (e.g. an older session).
    row = matches.find((r) => canon(r.id ?? "") === wanted) ?? matches[matches.length - 1];
    if (!row) {
      console.error(`no hook execution matches id ${id}`);
      Deno.exit(1);
    }
  } else {
    const session = explicitSession || envSession;
    if (!session) usage();
    row = rows.filter((r) => r.session === session).pop();
    if (!row) {
      console.error(`no hook executions logged for session ${session} in ${DIR}/decisions.jsonl`);
      Deno.exit(1);
    }
  }

  // Prefer the texts captured with the decision itself; only older rows without heads need the
  // transcript re-read (which by then reflects later turns, not the decision's turn).
  let request = row.evidence?.request_head ?? "";
  let final = row.evidence?.final_head ?? "";
  if ((!request || !final) && row.transcript) {
    try {
      const texts = textsFor(row.transcript, { turnId: row.turn, stopAt: row.at });
      request = request || texts.request;
      final = final || texts.final;
    } catch { /* transcript gone; the decision row still resolves via jev/show.ts */ }
  }

  const shouldContinue = expected === "authorized_unfinished";
  const hookContinue = row.decision === "continue";
  const agree = shouldContinue === hookContinue;
  const entry = {
    at: new Date().toISOString(),
    id: row.id ?? null,
    session: row.session ?? null,
    turn: row.turn ?? null,
    hook_decision: row.decision ?? null,
    expected,
    should_continue: shouldContinue,
    agree,
    note,
    jev: row.evidence?.jev ?? null,
    cwd: row.cwd ?? null,
    request,
    final,
    transcript: row.transcript ?? null,
  };
  await Deno.mkdir(DIR, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${DIR}/feedback.jsonl`, JSON.stringify(entry) + "\n", { append: true });
  console.log(
    `feedback recorded (${agree ? "confirmation" : "correction"}) id=${row.id ?? "?"} ` +
      `hook=${row.decision ?? "?"} expected=${expected} -> ${DIR}/feedback.jsonl`,
  );
  if (!request && !final) {
    console.log("note: no captured request/final head and no readable transcript; the decision row still resolves via jev/show.ts");
  }
}
