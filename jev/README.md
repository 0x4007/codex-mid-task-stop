# Jev-based premature-stop detector

Decides whether a Codex turn ended while authorized work remained, so a `Stop` hook can
request one continuation.

**This is an implementation of published work, not an invention.** Three existing projects
already solve parts of this problem; we adopt theirs rather than rebuild.

## Prior art (found 2026-09-30)

| Project | What it contributes | Link |
| --- | --- | --- |
| **Limpet** | Packaged Stop-hook implementation for preventing premature stops; scores and logs unless `LIMPET_BLOCK` is set. | [noplan-inc/limpet](https://github.com/noplan-inc/limpet) |
| **Mjolnir** (BrokkAI) | The `work` Choice rubric — the best answer to "is authorized work still outstanding?". | [BrokkAi/mjolnir](https://github.com/BrokkAi/mjolnir/blob/8119fe8f62f789c01dd0622a2c00278eb66dafaf/mj-core/src/activity/verdict_questions.json) |
| **Jev Belay** | Labelling rubric plus the rule that mechanical facts are read from the transcript, never judged by a model. | [valentynkit/jev-belay](https://github.com/valentynkit/jev-belay/blob/main/corpus/RUBRIC.md) |

## The detector

One semantic question, plus mechanical preconditions read from the transcript.

**`present_tense_v3`** (default, TypeSafe Noul): `noul >= floor` where the floor is 0.6 by
default (`CODEX_STOP_GUARD_PROBE_FLOOR` -> `CODEX_STOP_GUARD_MIN_PROBABILITY` ->
`CODEX_STOP_GUARD_MIN_CONFIDENCE` -> 0.6).

**`work`** (legacy, Mjolnir's rubric, Choice; `CODEX_STOP_GUARD_RUBRIC=work`):
`finished` | `authorized_unfinished` | `waiting` | `unclear`; continue when
`work == authorized_unfinished` with p >= 0.56.

**Continue when** (any arm, in either rubric) the turn ended without a tool call, the allowance
is unspent, and any of these holds:

- the probe clears its floor;
- any mechanical text receipt fires (`gate_unperformed_action`, `gate_explicit_missing`,
  `gate_in_progress_action`, `gate_decision_locked`, `gate_questions_without_attempt`);
- a completion claim in the final text is contradicted by the turn's own receipts
  (`claim_contradicted`; supported/unobserved stay diagnostic in the log).

`waiting` and `unclear` verdicts still allow the turn. Latency ~200ms per call.
Configuration: `detector-v2.json`; policy detail and measured results: `../docs/PUBLIC_POLICY.md`.

## Why the earlier attempts failed — implementation, not the model

1. **`criteria` on a noul describes yes and no; it is not a place to accumulate training
   examples.** Adding ten examples changed nothing.
2. **The criteria contradicted each other.** `true` covered "announces an action and stops";
   `false` covered "a long report listing future work is still finished". A completed report
   satisfies both, so the model was resolving an ambiguity we created.
3. **One compound question.** The TypeSafe building guide says to split independent factors
   and compose them in code.
4. **No `waiting` class.** A two-noul policy cannot distinguish "stopped mid-work" from
   "waiting for a sub-agent", so it would fire on work already in flight.

After adopting Mjolnir's `work` question, the compound true/false policy was replaced by one
four-way Choice, and the `waiting` class became expressible.

## Files

| File | What |
| --- | --- |
| `detector-v2.json` | **Current configuration** — the probe question, Belay's preconditions, the composed policy. |
| `questions-present-tense-v3.json` | The live default `present_tense_v3` question (byte-exact copy of `backtest/questions-present-tense-v3.json`, SHA-256 `7c63f7932901782f75223d677189e806a915dd2096b05667cf23f2d112f77beb`). |
| `questions-mjolnir-work.json` | The legacy `work` question, selected by `CODEX_STOP_GUARD_RUBRIC=work`. |
| `gates.ts` | Belay's mechanical preconditions plus the claim/receipt machinery, read from the transcript with no model call. |
| `score-public-policy.ts`, `public-policy-results.json` | Score and publish the policy on the public reviewed 100. |
| `claims_test.ts` | Offline receipt/claim unit tests. |
| `extract-triggers.py`, `build-corpus.py`, `build-truth-set.py` | Read-only local dataset builders over `~/.codex`; they write the gitignored `triggers.jsonl`, `corpus.jsonl` and `truth.jsonl`. |
| `build-review-set.py` | Emit a human-adjudicable review set from a scored corpus; writes the gitignored `review-set.md`. |
| `score-rubric.py`, `score-with-jev.py` | Score a local case set against the live question file (`score-rubric.py` takes `--questions`, `--cases`, `--out`); both write gitignored `score*.json`. |
| `feedback.ts` / `import-feedback.ts` | Record a labelled correction against a hook execution; fold `feedback.jsonl` into the gitignored `feedback-corpus.jsonl` for scoring. |
| `show.ts`, `spend.ts` | Resolve a logged execution id and report measured spend by session. |
| `dataset/` | Public 100-record reviewed corpus of deidentified real transcript endings: `DATASET.md` card, final `cases.jsonl`, frozen `splits.json` (dev 50 / heldout 50), final `stats.json`, and `validate.ts`. |

## Status

Working on real data; **not calibrated against human labels.** The labels are independent blind
agent review, not human ground truth. On the public reviewed 100 the shipped policy scores 90
(dev 40/50, heldout 50/50) against probe-only 88 and the legacy work baseline 85; details and
limits are in `../docs/PUBLIC_POLICY.md`. Heldout was consulted across earlier iterations, so it
is a regression set, not a blind prospective claim.

The public `dataset/` slice is separate and published-ready: 100 reviewed records with independent blind agent-review labels (`finished` 57, `authorized_unfinished` 26, `waiting` 16, `unclear` 1) and a frozen `dev` 50 / `heldout` 50 split. `dev` may support prompt/rubric refinement and teaching; `heldout` is evaluation-only. See `dataset/DATASET.md`.
