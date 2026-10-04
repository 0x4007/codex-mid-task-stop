---
name: stop-guard-feedback
description: Record the latest stop-guard Stop-hook decision in this session as a labelled training example for the mid-task-stop detector. Use when the user says the guard resumed wrongly or missed remaining work, or asks to give feedback on a [stop-guard] line.
metadata:
  short-description: Label the latest stop-guard decision
---

# Stop-guard feedback

Turn the newest `[stop-guard]` decision of this Codex session into a labelled example in the detector's feedback log, without the user typing an id.

1. A call with no verdict means `unfinished`: the user is reporting that the guard missed remaining work — the common, owner-only case. If the user's words clearly say otherwise, map them to `finished` (the turn was complete, cancelled, or superseded), `waiting` (a sub-agent, background job, or started test was in flight), or `unclear`, and pass that verdict explicitly.
2. Run, with the user's explanation as the note:

```
deno run --allow-read --allow-write --allow-env \
  <repo>/jev/feedback.ts --note "<user's words>"
```

Explicit verdicts are appended when the user's words call for them, e.g. `feedback.ts finished --note "no work remained"` (the resumed model's self-report uses exactly that form).

The visible `[stop-guard]` line prints the invocation for its execution — `$stop-guard-feedback sg_<session8>_<turn8>` — where the missing verdict means `unfinished`; an explicit verdict may come before or after the id. The script defaults to the most recent execution for this session via `$CODEX_THREAD_ID`; for an earlier execution, list with `--list` and pass the id copied from the line (older dotted ids still resolve).
3. Report the recorded line (id, hook decision, expected verdict, correction or confirmation) and stop. Do not edit any other state.

Details: `hook/README.md` in this repository. Labelled entries accumulate in `feedback.jsonl`; folding them into the local review set (`jev/review-set.md`) and corpus (`jev/corpus.jsonl`) is a separate manual step, and both generated files are gitignored.
