#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Probe Stop hook: records the exact payload Codex sends, then blocks once to
// test whether the turn re-enters the loop. Writes only to the probe log dir.
const logDir = Deno.env.get("CODEX_STOP_PROBE_DIR") ?? "./probe/logs";
await Deno.mkdir(logDir, { recursive: true });

const raw = await new Response(Deno.stdin.readable).text();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await Deno.writeTextFile(`${logDir}/${stamp}.input.json`, raw);

let input: Record<string, unknown> = {};
try {
  input = JSON.parse(raw);
} catch {
  await Deno.writeTextFile(`${logDir}/${stamp}.parse-error.txt`, raw);
}

const event = String(input.hook_event_name ?? "unknown");
const alreadyActive = input.stop_hook_active === true;
const last = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";

// Record the decision inputs so the detector can be designed from real data.
await Deno.writeTextFile(
  `${logDir}/${stamp}.summary.json`,
  JSON.stringify({ event, alreadyActive, session_id: input.session_id, turn_id: input.turn_id, last_assistant_message_len: last.length, last_assistant_message: last.slice(0, 4000) }, null, 2),
);

// Probe behaviour: block exactly once per turn. If alreadyActive is true, allow.
if (event === "Stop" && !alreadyActive) {
  console.log(JSON.stringify({ decision: "block", reason: "PROBE: continue with the remaining work." }));
} else {
  console.log(JSON.stringify({}));
}
