# Wiring the detector into a Codex Stop hook

The actuator is `stop-hook.ts`. The detector is `../jev/`.

## Installed configuration

`~/.codex/hooks.json` runs the hook on the `Stop` event with a 30s timeout:

```
CODEX_STOP_GUARD_DRY_RUN=1 deno run --allow-read --allow-write --allow-env --allow-run \
  <repo>/hook/stop-hook.ts
```

Set `CODEX_STOP_GUARD_DRY_RUN=1` to decide and log without continuing. Remove it to let the hook
intervene. State lives in `~/.local/state/codex-stop-guard/` (`CODEX_STOP_GUARD_DIR` overrides).

## Flow on every turn end

```
Stop event
  |- hook_event_name != Stop            -> allow
  |- stop_hook_active == true           -> let end (never continue twice for one turn)
  |- no session/turn/transcript         -> allow
  |- model is GPT/OpenAI                -> allow silently (free; the guard is for non-GPT models)
  |- gate_ends_without_tool_call false  -> allow   (free; ../jev/gates.ts, no model)
  |- allowance for (session, turn) spent-> allow
  |- jev `present_tense_v3` noul (~200ms; `work` Choice under CODEX_STOP_GUARD_RUBRIC=work)
  |    any mechanical text receipt       -> consume allowance, then continue
  |    a completion claim contradicted   -> consume allowance, then continue
  |    probe >= floor (default 0.6)
  |      with no waiting-state marker    -> consume allowance, then continue
  |    otherwise (incl. waiting markers) -> allow
```

Every decision is appended to `decisions.jsonl` with its evidence, whether or not it continued.
Rows with a jev verdict carry the effective `floor`, the measured `unfinished` probability, the
fired `text_receipts`, the `claim_contradicted` flag, and the decision-time `request_head` /
`final_head`, alongside the full verdict. That log is the measurement surface for the trial.

## The model gate

The guard is enabled only for non-GPT models. On every Stop the model recorded for the current turn
(`event.model` when the client sends it, else the latest turn-context record in the transcript) is
checked; GPT/OpenAI ids (`gpt*`, `openai*`, `codex*`, `o3`+) stand down silently and for free: no line,
no continuation, and one `model-gpt` row with the model in evidence. A transcript with no model record
leaves the guard on.

## The allowance

One continuation per original user turn, keyed by `(session_id, turn_id)`, written before the
continuation is emitted. A crash after consuming forfeits the opportunity; nothing refills it on
resume, fork, or compaction. This repository deliberately keeps the one-continuation allowance as
the only cap: the private lineage also removed its per-turn cap, and that divergence is not ported
here.

## Reason text

`[stop-guard] Turn ended mid-task (authorized_unfinished 0.87, receipts: in_progress_action, id
sg_<session8>_<turn8>). Continuing once. Continue the announced work, or state the blocker
explicitly. If nothing was pending, record the false positive: <feedback command>`

## Installing it (two traps that broke it once)

1. **Use the absolute deno path.** The client spawns hooks without a login shell, so a bare
   `deno` is ENOENT. The working command is the absolute path to your deno binary:
   `<path-to-deno> run --allow-read --allow-write --allow-env --allow-run <hook>`.
2. **The script must be executable** (`chmod +x hook/stop-hook.ts`), and so must `jev/gates.ts`.

## No goal-mode stand-down

Goal state is not readable from a transcript: goal creation writes a `thread_goal_updated`
record, but completing a goal writes nothing, so every session's last status stays `active`
(verified across every session on 2026-09-30). Any transcript-based stand-down therefore
becomes permanent. The hook fires on every turn instead, and always prints what it spent.

## The visible line

Every turn end prints one short line, whether or not it acts:

```
[stop-guard] resume | $0.000756 | 15 calls | 0.87/0.60 | $stop-guard-feedback sg_<session8>_<turn8>
[stop-guard] no resume | $0.000756 | 15 calls | 0.43/0.60 | $stop-guard-feedback sg_<session8>_<turn8>
```

The final pipe section is a ready-to-send skill invocation for that exact execution; a call with no verdict records `unfinished` (the guard missed remaining work), which is the only case the owner files by hand — false resumes are self-reported by the resumed model. The `0.87/0.60` token is the measured `authorized_unfinished` probability over the effective floor
(`-/0.60` when no jev call was made). `resume` appears only when the guard kept the turn going. Cost is the jev call; output tokens are
free on this route, so input tokens are the whole cost story. Per-call cost is in the decision log.

## The unique id

Every execution prints and logs one id: `sg_<session8>_<turn8>`, with `_n` appended when that id
would otherwise repeat in the session (repeat fires, or two turns sharing a short prefix). It sits
in the guard line's final section (the ready-to-send `$stop-guard-feedback` call), inside any
continuation reason (the only text that survives a continuation), and in `decisions.jsonl`. `jev/show.ts <id>` prints the record; older dotted ids (`sg.…`) still
resolve. Underscores only, so a double-click selects the whole id. Each hook gets its own prefix,
so a second hook never collides with `sg`.

## Giving feedback

From the session that saw the line, mark what the hook should have decided:

- `$stop-guard-feedback` — the skill (source: `skills/stop-guard-feedback/SKILL.md`, installed to
  `~/.codex/skills/`); a bare call records `unfinished` for the most recent execution, and the guard line
  prints the call with its exact id (`$stop-guard-feedback sg_<session8>_<turn8>`); other verdicts
  (`finished`, `waiting`, `unclear`) are given explicitly; or
- `/prompts:stop-feedback <what actually happened>` — the slash command (`~/.codex/prompts/stop-feedback.md`;
  restart Codex once after editing prompt files), or
- directly:

```
deno run --allow-read --allow-write --allow-env \
  <repo>/jev/feedback.ts unfinished --note "why"
```

Handling the entries: `deno run --allow-read --allow-write --allow-env jev/import-feedback.ts`
folds `feedback.jsonl` into `jev/feedback-corpus.jsonl` (the `corpus.jsonl` shape: `user_request`,
`assistant_final`, `label`) for the offline scoring harness; a manual label wins over an automatic entry for the same id. Both are local generated files and are gitignored.

Automatic capture: a continuation that runs no tool calls at all is recorded by the hook itself as a
`suspected_false_positive` entry (`auto`, `expected: null`), and the continuation reason carries the exact
`jev/feedback.ts finished --id …` command so a resumed agent can record a false positive directly;
`~/.codex/AGENTS.md` tells it to.

It defaults to the most recent execution for `$CODEX_THREAD_ID`; `--list` shows recent executions and
`--id` targets an older one. The labelled entry (hook decision, jev verdict, request/final text pulled
from the transcript) is appended to `feedback.jsonl` and never touches live detector state. Entries
are raw material for the local review set (`jev/review-set.md`) and corpus (`jev/corpus.jsonl`),
both generated locally and gitignored, not a live model update.

## Verified

| Test | Result |
| --- | --- |
| Turn ending on a tool call | `tool-call-at-end`, allowed |
| Text-only turn announcing unperformed work | jev `authorized_unfinished` 0.93, continues |
| Second fire on the same turn | `allowance-spent`, allowed |
| Decision logging | every path appends with evidence |
| Unique id | isolated smoke: same turn twice -> `sg.…` then `sg.….2`; live ids resolve via `jev/show.ts` |
| Feedback capture | `feedback.ts` auto-selects the latest execution for `$CODEX_THREAD_ID` and stores request/final from the transcript |
| Model gate | gpt transcript -> `model-gpt`, no jev call; deepseek transcript -> judged |
| No-work continuation | follow-up Stop auto-records `suspected_false_positive` for the prior continue, once |
| Floor telemetry | every jev row logs `floor` and the measured `unfinished` probability |

## Uninstall

Restore the backup: `cp ~/.codex/hooks.json.bak-before-stop-guard-<timestamp> ~/.codex/hooks.json`

## Status

Installed in dry-run after live verification. Precision is unmeasured; the locally generated
review set (`../jev/review-set.md`) holds the cases that would establish it, and `decisions.jsonl` accumulates real outcomes meanwhile.
