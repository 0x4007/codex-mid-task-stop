# Codex mid-task stop

A Codex `Stop` hook that requests exactly one continuation when a turn ends while authorized work
remains, with the deterministic gates, the semantic detector, and the probe harness behind it.

## The mechanism

Codex ends a turn when a whole assistant response contains no tool call. A `Stop` hook returning
`decision: "block"` re-enters the loop: the continuation renders visibly and costs one model call
(`probe/`, live-verified 2026-09-30). The part that is not solved is the detector — a false
completion and a legitimate final answer have the same shape, assistant text with no tool call —
so this repository keeps the working actuator and makes every decision measurable instead of
shipping automatic continuation on an unproven signal.

On every turn end the hook:

1. runs deterministic gates read from the transcript, with no model call (`jev/gates.ts`);
2. consults one semantic `work` Choice question — `finished` | `authorized_unfinished` |
   `waiting` | `unclear` — only when the gates pass;
3. consumes a one-continuation allowance for `(session_id, turn_id)` before emitting anything;
4. logs every decision with its evidence, and prints one line whether or not it acts.

## Layout

| Path | What |
| --- | --- |
| `hook/stop-hook.ts` | The `Stop` hook: gates, semantic judgement, allowance, decision log, visible line. |
| `hook/README.md` | Wiring, flow, the model gate, the allowance, the unique id and feedback handling. |
| `jev/gates.ts` | Mechanical preconditions read from the transcript, no model call. |
| `jev/detector-v2.json` | Current detector policy and its published sources. |
| `jev/questions-mjolnir-work.json` | The live `work` question the hook loads. |
| `jev/feedback.ts`, `jev/import-feedback.ts`, `jev/show.ts`, `jev/spend.ts` | Label a decision, fold feedback into a local corpus, resolve an execution, report spend. |
| `probe/` | The isolated harness that proved a blocking `Stop` hook re-enters the loop. |
| `skills/stop-guard-feedback/SKILL.md` | Skill that turns a `[stop-guard]` line into a labelled example. |

## Usage

Wire `hook/stop-hook.ts` into `~/.codex/hooks.json` on the `Stop` event (see `hook/README.md`).
`CODEX_STOP_GUARD_DRY_RUN=1` decides and logs without continuing; remove it to let the hook
intervene. State lives outside the repository: `$CODEX_STOP_GUARD_DIR`, defaulting to
`$HOME/.local/state/codex-stop-guard`, holds `decisions.jsonl`, `feedback.jsonl` and the
per-turn allowances.

The semantic step runs the `work` question through the separate `jev-sandbox` Python package
(`uv run python`, from a private checkout outside this repository). That package is not part of
this repository, so in a fresh checkout the detector answers `jev-error`, the hook allows the turn,
and the deterministic gates and probe harness still work.

## Local-only datasets

The builders read the local Codex store (`~/.codex`) read-only and write generated files that are
listed in `.gitignore`:

| Tool | Output |
| --- | --- |
| `jev/build-corpus.py` | `jev/corpus.jsonl` |
| `jev/build-truth-set.py` | `jev/truth.jsonl` |
| `jev/extract-triggers.py` | `jev/triggers.jsonl` |
| `jev/build-review-set.py` | `jev/review-set.md` |
| `jev/import-feedback.ts` | `jev/feedback-corpus.jsonl` |
| `jev/score-rubric.py`, `jev/score-with-jev.py` | `jev/score*.json` |
| `probe/stop-hook.ts` | `probe/logs/` |

Those outputs contain private session text. Generate them locally, keep them out of version
control, and never publish them.

## Public dataset

`jev/dataset/` publishes a 100-record reviewed corpus of deidentified real transcript endings for the `work` completion judgement, with independent blind agent-review labels, a frozen `dev` 50 / `heldout` 50 group split, distribution accounting, and a read-only validator.

`dev` examples may support prompt, rubric, and teaching-material refinement; `heldout` is evaluation-only. See `jev/dataset/DATASET.md` for the schema, label provenance, deidentification rules, coverage bias, and limits.

Validate the published corpus (no network, no model calls):

```sh
deno run --allow-read jev/dataset/validate.ts
```

## Private backtesting sandbox

`backtest/` is a replay-only sandbox for measuring the `work` judgement on real sessions and on the frozen public benchmark, with a bounded loop that edits question text and the caller floor only. It never installs a live hook, changes config, or publishes; all snapshots, mappings, caches and results stay under the ignored `.publication-audit/backtesting/` path. Local ingestion is read-only and needs no model call; the paid protocol and the independent annotation batch are root-run steps. See `backtest/README.md`.

## Prior art

The detector adopts published work rather than inventing it; the sources and the question are in
`jev/README.md` and `jev/detector-v2.json`.