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

**`work`** (Mjolnir's rubric, Choice): `finished` | `authorized_unfinished` | `waiting` | `unclear`.

**Continue only when** `work == authorized_unfinished` **and** the turn ended without a tool
call **and** `stop_hook_active` is false.

- `finished` — requested work complete, cancelled, superseded, or the user only asked a question.
- `waiting` — background work or a sub-agent is in flight; continuing would duplicate it.
- `unclear` — refuse.

Latency ~200ms per call. Configuration: `detector-v2.json`.

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
| `detector-v2.json` | **Current configuration** — Mjolnir's question, Belay's preconditions, the policy. |
| `questions-mjolnir-work.json` | The live `work` question the hook loads. |
| `gates.ts` | Belay's mechanical preconditions, read from the transcript with no model call. |
| `extract-triggers.py`, `build-corpus.py`, `build-truth-set.py` | Read-only local dataset builders over `~/.codex`; they write the gitignored `triggers.jsonl`, `corpus.jsonl` and `truth.jsonl`. |
| `build-review-set.py` | Emit a human-adjudicable review set from a scored corpus; writes the gitignored `review-set.md`. |
| `score-rubric.py`, `score-with-jev.py` | Score a local case set against the live question file (`score-rubric.py` takes `--questions`, `--cases`, `--out`); both write gitignored `score*.json`. |
| `feedback.ts` / `import-feedback.ts` | Record a labelled correction against a hook execution; fold `feedback.jsonl` into the gitignored `feedback-corpus.jsonl` for scoring. |
| `show.ts`, `spend.ts` | Resolve a logged execution id and report measured spend by session. |

## Status

Working on real data; **not yet calibrated against human labels.** Precision and recall are
unknown until a locally generated review set is adjudicated. Known residual error: progress
reports that mention remaining work ("Committed cleanly… Working tree is clean") can be
classified `authorized_unfinished`, which is the deliberate trade-off in Mjolnir's rubric, and
the reason Belay insists on mechanical preconditions.
