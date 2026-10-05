# Private Jev backtesting sandbox

A replay-only sandbox for measuring the `work` completion judgement on real
sessions and on the frozen public benchmark, with a bounded automatic
improvement loop that edits question text and the caller floor only. It never
installs a live hook, changes product config, or publishes anything; every
output stays under the ignored `.publication-audit/backtesting/` path.

This is question/policy optimization, not training. The mechanism is exactly the
one the original teaching commits used: a bounded sentence in
`work.instructions.question` or a `work.criteria.*.what` field, plus the
caller-side resume floor. There are no weights, no fine-tuning, no new examples,
no new primitive/id/model, and no option changes.

## Entry scripts

All entries are zero-argument with fixed defaults; the optional private override
is `.publication-audit/backtesting/writer-config.json` (ignored, unknown keys
fail closed). No new CLI flag, env name, or secret is introduced; the only env
inputs are the documented `HOME`/`PATH`, `OPENROUTER_API_KEY`, `JEV_CACHE`, and
`UV_CACHE_DIR` for uv's own cache during tests.

| Command                                                                                                                                                                                                                                        | What                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno run --allow-read=/home/codex/.codex,/home/codex/.local/state/repo-public-audit-20261004-135605/repository.git,. --allow-write=.publication-audit/backtesting --allow-run=git,zstd backtest/ingest.ts`                                    | Read-only local ingestion: transcripts, archived zst, read-only thread DB; scrub, freeze, coverage report, grouped split, blind12 queue, frozen baseline inputs. No model call.                                                                                                                                                                                                  |
| `deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/prepare.ts`                                                                                                                        | Version-2 preparation from the existing frozen snapshots: import the hash-bound reviewer labels, build the new v2 queue (6 local dev + 6 local heldout, disjoint groups, shape-spread), and write the versioned manifest. No re-ingestion, no model call.                                                                                                                        |
| `deno run --allow-read=.,/home/codex/repos/0x4007/jev-sandbox --allow-write=.publication-audit/backtesting --allow-env=OPENROUTER_API_KEY,JEV_CACHE,HOME,PATH --allow-run=uv backtest/run.ts`                                                  | Bounded protocol: AUTO/PRE/CUR on the frozen public heldout50 (legacy string instructions adapted before the first request), champion plus at most two candidate trials on public dev49 AND the gated local dev labels, winner on public heldout50 AND the gated local heldout labels, persisted hash-verified champion. Paid only when a key is present; abort, never fallback. |
| `deno run --allow-read=.publication-audit/backtesting --allow-write=.publication-audit/backtesting backtest/labels.ts`                                                                                                                         | Import the two reviewers' annotations for the current queue (v2 when present, else v1): exact queue sha256 and per-pair sha256 binding, privacy_pass AND context_sufficient on both, full coverage, no disputes, then join to source case/group/split. Any gap emits no labels. Never launches a reviewer.                                                                       |
| `deno test --allow-read=.publication-audit/backtesting,/home/codex/repos/0x4007/jev-sandbox,/tmp --allow-write=.publication-audit/backtesting,/tmp --allow-run=uv,python3 --allow-env=HOME,PATH,OPENROUTER_API_KEY,JEV_CACHE backtest/test.ts` | Offline confidence checks: carrier parsing, inert captured commands, fail-closed secrets, coverage/privacy/hash-binding gates, legacy-instruction adapter compiled offline on all three arms, unknown-usage and disabled-cache behavior, candidate immutability. No network, no shared-cache writes.                                                                             |

Every command is zero-argument; the exact argv is also recorded in
`writer-run-report.json` under `root_commands`.

## Data provenance and coverage

The collector reads every available local root-user transcript, the archived
`.jsonl.zst` sessions, and the read-only `thread_history_1.sqlite` message data,
and freezes a scrubbed snapshot with a private source mapping at mode 0700/0600.

Pairs come from canonical carriers only: turn brackets plus `response_item`
messages, with real user steering (injected context blocks, bootstrap AGENTS
text, and reasoning excluded) and the assistant `phase == "final_answer"`.
Children, sessions operating on this audit workspace, duplicated
`event_msg item_completed` carriers, open turns, and turns after the fixed
cutoff are excluded. The DB-only tier is used only where `thread_turns` pointers
resolve to real item rows; it has no turn brackets or phase metadata, so it is a
lower-confidence corpus and never a benchmark arm.

This host is not all devices. Local coverage is reported exactly as measured,
and the Mac/other-host store plus any pre-2026-09-03 store not migrated into the
local DB is listed as unavailable. The run never claims to have captured every
device.

## Bounded loop and promotion

The candidate proposer sees the train/dev rows only; the locked heldout split is
never passed to it. The protocol ceiling is 2 trials, 350 logical Jev requests,
and $0.05 estimated cost at the observed 1,505 input tokens per call and
$0.042/Mtok. The champion stays `CUR` unless a candidate improves dev and then
passes the locked-heldout gate (no false-resume increase, accuracy within 0.02).
A provider error aborts the run with a status and leaves the champion unchanged;
no metric is fabricated.

Measured metrics are exact 4-way choice agreement, binary agreement at the
caller floor, the false-resume and false-stop classes, confidence strata, paired
flips between arms, and cache/token/cost counters. A rerun of the identical
command must be all cache hits with zero bought tokens; the SDK's own default
cache is reused, and unit mocks use isolated temporary caches so the shared
`.jev-cache` is never poisoned.

## Independent annotation (root-run)

`backtest:ingest` writes `writer-cases/blind-queue.json`: 12 representative
local real-session cases with no prior labels, no raw secrets, no source ids,
and no future-user signals. The root runs two independent DSH reviewers over it
in two batches of six and records the results in
`writer-cases/writer-judge-cache.json`; the sandbox never launches DSH itself.

`backtest:labels` accepts an entry only when it exited 0, reports
`header_verified`, shows the actual `Ultra/max` header and `workspace-write/ask`
sandbox, and echoes an Ultra/max model. It emits labels only for items both
reviewers accepted and agreed on, with `independent_agent_review` provenance;
disagreements stay disputed. This is independent agent review, never human
annotation or ground truth.

## Known limits

Local pairs carry no gold labels, so the local panel is provenance and
annotation material, not an accuracy benchmark; the frozen public heldout50 is
the independent evaluation side. The original18 fit control is reported from the
cached Oct 3 artifact and is training-fit, not independent gold; its raw rows
are preserved privately and were not sent to a provider. The optional local paid
arms remain unlaunched while `OPENROUTER_API_KEY` is absent, and running them is
the root's step. Promotion is a sandbox recommendation for review, not a live
policy change.
