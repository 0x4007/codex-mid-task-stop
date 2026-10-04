#!/usr/bin/env -S deno run --allow-read --allow-env
// Look up a decision by the ids printed on the hook line.
//
//   deno run --allow-read --allow-env jev/show.ts <sg-id>          e.g. sg_<session8>_<turn8>_2
//   deno run --allow-read --allow-env jev/show.ts <session8> [turn8]
//   deno run --allow-read --allow-env jev/show.ts --last 5

const DIR = Deno.env.get("CODEX_STOP_GUARD_DIR") ??
  `${Deno.env.get("HOME")}/.local/state/codex-stop-guard`;

interface Row {
  at?: string;
  id?: string;
  session?: string;
  turn?: string;
  decision?: string;
  allowed?: boolean;
  transcript?: string | null;
  evidence?: {
    goal_status?: string | null;
    jev?: { choice?: string; confidence?: number; cost_usd?: number; input_tokens?: number };
  };
}

function load(): Row[] {
  try {
    return Deno.readTextFileSync(`${DIR}/decisions.jsonl`)
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Row];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const args = Deno.args;
  const rows = load();

  if (args[0] === "--last") {
    const n = Number(args[1] ?? 5);
    for (const r of rows.slice(-n)) {
      console.log(format(r));
    }
    Deno.exit(0);
  }

  const [first, second] = args;
  if (!first) {
    console.error("usage: show.ts <sg-id> | <session8> [turn8]   |   show.ts --last N");
    Deno.exit(2);
  }
  // Accept the underscore form and the older dotted ids (dots normalize to underscores).
  const canon = (v: string) => v.replace(/^sg[._]/, "").replace(/\./g, "_");
  const wanted = canon(first);
  const isExecId = first.startsWith("sg.") || first.startsWith("sg_") || wanted.includes("_");
  const match = isExecId
    ? rows.filter((r) => {
      const rid = canon(r.id ?? "");
      return rid === wanted || rid.startsWith(wanted + "_");
    })
    : rows.filter((r) => {
      const s = (r.session ?? "").replace(/-/g, "").startsWith(wanted);
      if (!s) return false;
      if (!second) return true;
      return (r.turn ?? "").replace(/-/g, "").startsWith(second);
    });
  if (!match.length) {
    console.log("no matching decision");
    Deno.exit(1);
  }
  for (const r of match) console.log(format(r));
}

function format(r: Row): string {
  const jev = r.evidence?.jev;
  const spent = jev ? `$${(jev.cost_usd ?? 0).toFixed(6)}` : "$0.000000";
  return [
    `id=${r.id ?? "?"}`,
    r.at,
    r.decision,
    `spent=${spent}`,
    jev ? `jev=${jev.choice} ${(jev.confidence ?? 0).toFixed(2)} in=${jev.input_tokens}` : "no jev call",
    `session=${(r.session ?? "").slice(0, 13)}`,
    `turn=${(r.turn ?? "").slice(0, 13)}`,
  ].join("  ");
}
