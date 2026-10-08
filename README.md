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
2. consults the semantic `present_tense_v3` Noul question (default) — or the legacy `work`
   Choice when `CODEX_STOP_GUARD_RUBRIC=work` — only when the gates pass;
3. continues when any mechanical text receipt fires, when a completion claim is contradicted by
   the turn's own receipts, or when the probe clears its floor (default 0.6) with no waiting-state
   marker in the final (receipts and contradictions override the marker);
4. consumes a one-continuation allowance for `(session_id, turn_id)` before emitting anything;
5. logs every decision with its evidence, and prints one line whether or not it acts.

## Layout

| Path | What |
| --- | --- |
| `hook/stop-hook.ts` | The `Stop` hook: gates, semantic judgement, allowance, decision log, visible line. |
| `hook/README.md` | Wiring, flow, the model gate, the allowance, the unique id and feedback handling. |
| `jev/gates.ts` | Mechanical preconditions and the receipt machinery, read from the transcript, no model call. |
| `jev/detector-v2.json` | Current detector policy and its published sources. |
| `jev/questions-present-tense-v3.json` | The live `present_tense_v3` Noul question the hook loads by default. |
| `jev/questions-mjolnir-work.json` | The legacy `work` question, selected by `CODEX_STOP_GUARD_RUBRIC=work`. |
| `jev/score-public-policy.ts` | Scorer for the decision policy on the public 100, fresh or from verdict files. |
| `jev/public-policy-results.json` | Published policy results on the public reviewed 100 (see `docs/PUBLIC_POLICY.md`). |
| `jev/claims_test.ts` | Offline receipt/claim unit tests (`deno test --allow-read jev/claims_test.ts`). |
| `jev/feedback.ts`, `jev/import-feedback.ts`, `jev/show.ts`, `jev/spend.ts` | Label a decision, fold feedback into a local corpus, resolve an execution, report spend. |
| `probe/` | The isolated harness that proved a blocking `Stop` hook re-enters the loop. |
| `skills/stop-guard-feedback/SKILL.md` | Skill that turns a `[stop-guard]` line into a labelled example. |

## Usage

Wire `hook/stop-hook.ts` into `~/.codex/hooks.json` on the `Stop` event (see `hook/README.md`).
`CODEX_STOP_GUARD_DRY_RUN=1` decides and logs without continuing; remove it to let the hook
intervene. State lives outside the repository: `$CODEX_STOP_GUARD_DIR`, defaulting to
`$HOME/.local/state/codex-stop-guard`, holds `decisions.jsonl`, `feedback.jsonl` and the
per-turn allowances.

The semantic step runs the `present_tense_v3` question (or `work` under
`CODEX_STOP_GUARD_RUBRIC=work`) through the separate `jev-sandbox` Python package
(`uv run python`, from a checkout outside this repository; `HOME/repos/0x4007/jev-sandbox` is the
default, with `CODEX_STOP_GUARD_JEV_REPO` and `CODEX_STOP_GUARD_UV` overrides, and `REPO` resolved
from the hook's own location or `CODEX_STOP_GUARD_REPO`). That package is not part of this
repository, so in a fresh checkout the detector answers `jev-error`, the hook allows the turn,
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

The decision policy (`probe_plus_receipts`, revision 2026-10-07) is measured on the same
reviewed 100: 97/100 (dev 47/50, heldout 50/50) against the legacy work baseline 85/100 and
probe-only 88/100. Recompute it fresh (`--fresh`) or by composition over saved verdict files; see
`docs/PUBLIC_POLICY.md` for the method, tables, and limits.

## Private backtesting sandbox

`backtest/` is a replay-only sandbox for measuring the `work` judgement on real sessions and on the frozen public benchmark, with a bounded loop that edits question text and the caller floor only. It never installs a live hook, changes config, or publishes; all snapshots, mappings, caches and results stay under the ignored `.publication-audit/backtesting/` path. Local ingestion is read-only and needs no model call; the paid protocol and the independent annotation batch are root-run steps. See `backtest/README.md`.

## Prior art

The detector adopts published work rather than inventing it; the sources and the question are in
`jev/README.md` and `jev/detector-v2.json`.