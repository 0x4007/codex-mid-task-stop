// Receipt/claim unit tests. Run: deno test --allow-read jev/claims_test.ts
//
// Offline: pure functions from ./gates.ts plus file hashes; no model call, no network.
import { claimEvidenceFor, classifyCommand, textReceipts } from "./gates.ts";

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const status = (
  text: string,
  receipts: ReturnType<typeof classifyCommand>[],
  claim: string,
) => claimEvidenceFor(text, receipts).find((c) => c.claim === claim)?.status;

Deno.test("commit claim supported by a commit command", () => {
  const r = classifyCommand(
    "exec_command",
    "git commit -m 'fix'",
    "[main abc1234] fix",
  );
  assertEq(status("Committed cleanly.", [r], "commit"), "supported", "commit");
});

Deno.test("rerun-fixed contradicted when no check command was captured", () => {
  const r = classifyCommand("exec_command", "cat file.ts", "contents");
  assertEq(
    status(
      "re-running it fixed, plus an exact-id preference.",
      [r],
      "rerun-fixed",
    ),
    "contradicted",
    "rerun-fixed",
  );
});

Deno.test("tests-pass supported by a passing check after the last change", () => {
  const mut = classifyCommand("exec_command", "apply_patch <<patch", "done");
  const check = classifyCommand("exec_command", "deno test", "5 passed in 1s");
  assertEq(
    status("All 5 tests pass.", [mut, check], "tests-pass"),
    "supported",
    "tests-pass",
  );
});

Deno.test("tests-pass contradicted when post-change checks fail", () => {
  const mut = classifyCommand("exec_command", "apply_patch <<patch", "done");
  const check = classifyCommand("exec_command", "deno test", "error: 2 failed");
  assertEq(
    status("All tests pass, lint is clean.", [mut, check], "tests-pass"),
    "contradicted",
    "tests-pass",
  );
});

Deno.test("negated claims are ignored", () => {
  const r = classifyCommand(
    "exec_command",
    "cat notes.md",
    "this was not committed",
  );
  assertEq(
    claimEvidenceFor("Nothing was committed; no tests were run.", [r]).length,
    0,
    "negated",
  );
});

Deno.test("waiting claim supported only by a captured job call", () => {
  const r = classifyCommand("wait", '{"cell_id":"1"}', "Script completed");
  assertEq(
    status("Holding for the worker:", [r], "waiting"),
    "supported",
    "waiting-supported",
  );
  const plain = classifyCommand("exec_command", "ls", "files");
  assertEq(
    status("Holding for the worker:", [plain], "waiting"),
    "unobserved",
    "waiting-unobserved",
  );
});

Deno.test("behavior claims are unobserved by design", () => {
  const r = classifyCommand(
    "exec_command",
    "cat gates.ts",
    "logged as model-gpt",
  );
  assertEq(
    status("...free path, logged as model-gpt.", [r], "behavior-claim"),
    "unobserved",
    "behavior",
  );
});

Deno.test("behavior claim supported only by an explicit in-turn check of the token", () => {
  const checked = classifyCommand(
    "exec_command",
    "grep model-gpt app.log",
    "model-gpt: ok",
  );
  assertEq(
    status("free path, logged as model-gpt.", [checked], "behavior-claim"),
    "supported",
    "behavior-checked",
  );
  const echoed = classifyCommand(
    "exec_command",
    "deno run check.ts",
    "... logged as model-gpt ...",
  );
  assertEq(
    status("free path, logged as model-gpt.", [echoed], "behavior-claim"),
    "unobserved",
    "behavior-echo-only",
  );
  const readOnly = classifyCommand(
    "exec_command",
    "cat gates.ts",
    "logged as model-gpt",
  );
  assertEq(
    status("free path, logged as model-gpt.", [readOnly], "behavior-claim"),
    "unobserved",
    "behavior-readonly",
  );
});

Deno.test("file-scoped claims require a receipt touching the named file", () => {
  const mutOther = classifyCommand("exec_command", "tee other.ts", "");
  const pass = classifyCommand("exec_command", "deno test", "5 passed");
  assertEq(
    status("Rerunning it fixed feedback.ts.", [mutOther, pass], "rerun-fixed"),
    "unobserved",
    "scope-unrelated",
  );
  const mut = classifyCommand(
    "exec_command",
    "*** Update File: feedback.ts",
    "",
  );
  const pass2 = classifyCommand("exec_command", "deno test", "5 passed");
  assertEq(
    status("Rerunning it fixed feedback.ts.", [mut, pass2], "rerun-fixed"),
    "supported",
    "scope-matched",
  );
});

Deno.test("in-progress gerund openers are receipts", () => {
  const gate =
    "Model is recorded per turn in the transcript. Implementing the gate: transcript model read in gates.ts, stand-down for gpt/openai, free path, logged as model-gpt.";
  const layers =
    "Doing all three layers now: the model gets the exact command, AGENTS.md carries the rule, and the hook auto-records the class.";
  const contracting =
    "Live acceptance: the fix works. The unfixed code failed closed, which exposed the defect. Contracting the correction:";
  const verifying =
    "Their design is the right one. Verifying the exact mechanics the swap will use (socket indirection + instance launch flags).";
  for (
    const [text, label] of [[gate, "gate"], [layers, "layers"], [
      contracting,
      "contracting",
    ], [verifying, "verifying"]] as const
  ) {
    assertEq(textReceipts("", text).gate_in_progress_action, true, label);
  }
  const done =
    "Yes. I just re-ran the full acceptance on both machines, two hours after the fix. Mac: exit 0. Code is committed at abc1234.";
  assertEq(
    textReceipts("", done).gate_in_progress_action,
    false,
    "done-report",
  );
});

Deno.test("first-person unperformed action is a receipt", () => {
  const t =
    "Yes\u2014I found and can read the saved conversation. I haven\u2019t yet established whether that writer is still active. I haven\u2019t restored opening it in your app yet. I haven\u2019t changed your configuration or restarted anything.";
  assertEq(
    textReceipts("can you?", t).gate_unperformed_action,
    true,
    "unperformed",
  );
  const done =
    "We have not conclusively established the entire cause. The newly deployed release has not yet completed another scheduled backup cycle.";
  assertEq(textReceipts("", done).gate_unperformed_action, false, "we-not-i");
});

Deno.test("explicit-missing receipts ignore by-design deferrals and instructions", () => {
  const gap =
    "It does not yet reproduce the remaining four requests. The POST sequence is not implemented as a fresh client. What is missing is code that creates the payloads.";
  assertEq(textReceipts("", gap).gate_explicit_missing, true, "missing");
  const deferred =
    "Your four pre-existing dirty files remain untouched and uncommitted. Still not done, by design: the operation journal with an exit-4 path.";
  assertEq(textReceipts("", deferred).gate_explicit_missing, false, "by-design");
  const proposal =
    "5. If required context still cannot be assembled safely, pause and report what is missing.";
  assertEq(
    textReceipts("", proposal).gate_explicit_missing,
    false,
    "instruction",
  );
  const external =
    "The newly deployed release has not yet completed another scheduled backup cycle.";
  assertEq(
    textReceipts("", external).gate_explicit_missing,
    false,
    "external-state",
  );
});

Deno.test("locked-decision and question-only receipts", () => {
  const locked =
    "The product choice is now locked: safety first, then latency and cost.";
  assertEq(textReceipts("", locked).gate_decision_locked, true, "locked");
  const done =
    "Almost. Confirmed: production is live. Not yet proven in production is the full scheduled path. To verify that, schedule one test post and confirm.";
  assertEq(textReceipts("", done).gate_decision_locked, false, "not-locked");
  const questions =
    "When it drops, does the device disappear or show offline in Remote, or does the chat stay connected but inference stop? What do you manually restart? A recent approximate drop time would also help.";
  assertEq(
    textReceipts(
      "Something is broken with the provider. Is there any telemetry you can use to fix the problem",
      questions,
    ).gate_questions_without_attempt,
    true,
    "questions",
  );
  const handoff =
    "Understood. I\u2019ll coordinate all subagents, assign ownership, and consolidate findings. Send the task when ready.";
  assertEq(
    textReceipts("You are the coordinator. Delegate bounded tasks.", handoff)
      .gate_questions_without_attempt,
    false,
    "handoff",
  );
});

Deno.test("quoted receipt examples in a report are not receipts", () => {
  const report =
    'What shipped: unperformed action ("I haven\u2019t restored\u2026"), explicit missing ("What is missing is X"), locked close ("the choice is now locked").';
  const tr = textReceipts("", report);
  assertEq(tr.gate_unperformed_action, false, "quoted-unperformed");
  assertEq(tr.gate_explicit_missing, false, "quoted-missing");
  assertEq(tr.gate_decision_locked, false, "quoted-locked");
  const real = "I haven\u2019t restored opening it in your app yet.";
  assertEq(
    textReceipts("", real).gate_unperformed_action,
    true,
    "unquoted-still-fires",
  );
});

Deno.test("mixed-delimiter quoted examples are stripped", () => {
  const mixed =
    'the receipt examples (`"I haven\u2019t restored\u2026"`) and in-progress (`"Implementing X:"`).';
  const tr = textReceipts("", mixed);
  assertEq(tr.gate_unperformed_action, false, "backtick-quoted-unperformed");
  const real =
    "The deploy is pending. I haven\u2019t restored opening it in your app yet.";
  assertEq(
    textReceipts("", real).gate_unperformed_action,
    true,
    "unquoted-fires",
  );
});

Deno.test("composed policy: probe arm, receipt arm, and the published question hash", async () => {
  // Receipts-only firing on a real public dataset row (public-0010, labelled
  // authorized_unfinished): the final closes on a gerund label, so the mechanical receipt
  // arm fires even though the probe arm may not.
  const rows = Deno.readTextFileSync("jev/dataset/cases.jsonl")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id: string; user_request: string; assistant_final: string });
  const row = rows.find((r) => r.id === "public-0010");
  if (!row) throw new Error("public-0010 missing from the dataset");
  const tr = textReceipts(row.user_request.slice(0, 900), row.assistant_final.slice(0, 1200));
  assertEq(tr.gate_in_progress_action, true, "public-0010 in-progress receipt");
  const composed = Object.values(tr).some(Boolean);
  if (!composed) {
    throw new Error("expected a mechanical receipt on public-0010; policy composition would miss it");
  }
  // The live v3 question file must equal the published comparator bytes.
  const published = "7c63f7932901782f75223d677189e806a915dd2096b05667cf23f2d112f77beb";
  const digest = async (path: string) =>
    [...new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      await Deno.readFile(path),
    ))].map((x) => x.toString(16).padStart(2, "0")).join("");
  assertEq(await digest("jev/questions-present-tense-v3.json"), published, "live v3 sha");
  assertEq(await digest("backtest/questions-present-tense-v3.json"), published, "comparator sha");
});
