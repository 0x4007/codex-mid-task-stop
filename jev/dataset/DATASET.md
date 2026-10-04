# Jev completion dataset (public slice)

**Status: published-ready reviewed corpus.** `cases.jsonl` contains 100 real, deidentified transcript endings with independent blind agent-review labels, a frozen `dev`/`heldout` group split, distribution accounting, and a zero-flag validator. No model metric is claimed by this export.

## What this is

A curated slice of real Codex transcript endings for the `work` choice used by the stop hook: `finished | authorized_unfinished | waiting | unclear`.

Each record is one real user request followed by the assistant's final text for that turn, exactly as the hook presents it to the model; the judgement task is whether authorized work remained when the turn ended.

This is labelled development, teaching, and evaluation data. `dev` examples may support prompt, rubric, and teaching-material refinement; `heldout` examples are evaluation-only and should not be used to tune the rubric. This export performs no model training or fine-tuning and claims no accuracy gain.

- 100 records, all natural transcript pairs (`natural: true`); there are no synthetic conversations and no manufactured `waiting`/`unclear` examples.
- Complete model-window text only: `user_request <= 900` characters and `assistant_final <= 1200` characters with `context.truncated = false`; rows outside the windows were excluded, never silently truncated.
- One source pair per published private thread, zero duplicate normalized pairs, and each group appears in exactly one split.
- Splits: `dev` 50 / `heldout` 50.
- Labels: `finished` 57, `authorized_unfinished` 26, `waiting` 16, `unclear` 1; label confidence: `high` 54 / `medium` 46.

## Files

| File | What |
| --- | --- |
| `cases.jsonl` | The 100-record reviewed corpus, one JSON object per line. |
| `splits.json` | Frozen opaque group assignment for `dev`/`heldout`, whole groups only. |
| `stats.json` | Final distribution accounting (`status: final_independent_review`). |
| `validate.ts` | Read-only, zero-flag validator: schema, label domain, windows, ids/groups, normalized duplicates, split isolation/balance, metadata, and a fail-closed privacy scanner. |

## Record schema

```json
{
  "id": "public-0001",
  "group_id": "group-0001",
  "split": "dev",
  "task": "completion_judgment",
  "user_request": "<sanitized, 40-900 chars>",
  "assistant_final": "<sanitized, 40-1200 chars>",
  "label": "authorized_unfinished | finished | waiting | unclear",
  "label_authority": "independent_agent_review",
  "label_confidence": "high | medium | low",
  "sanitization": {
    "method": "deterministic_entity_placeholder_v2",
    "edit_ops": ["identity_placeholder", "commit_placeholder"],
    "placeholders": ["[ORG]", "[COMMIT]"],
    "semantics_preserved": true,
    "scorer_truncation_applied": false,
    "writer_privacy_pass": true
  },
  "natural": true,
  "context": { "request_window_chars": 900, "final_window_chars": 1200, "truncated": false },
  "source_signal": { "kind": "owner_continuation_nudge", "strength": "strong_proxy" }
}
```

## Label provenance

- Every record carries `label_authority = independent_agent_review`. No record claims human annotation, owner verification, or ground truth.
- Labels and confidence come from an independent blind review: two root-assigned agent reviewers annotated a partition of the sanitized pairs without seeing source family, original heuristic labels, trigger metadata, or Jev/detector output.
- Five reviewed rows were dropped instead of relabelled: four whose pair context reviewers judged insufficient, and one whose topic was a financial product vertical that the documented exclusion policy keeps out.
- Never used as labels: mechanical zero-tool-call labels, detector/Jev predictions, scoring files, or the corpus builder's nudge heuristic. Those signals only shaped the candidate pool.
- Each record discloses a public-safe behavioural source signal through `source_signal`:
  - `owner_continuation_nudge` / `strong_proxy`: the next transcript message was an explicit continue/proceed nudge.
  - `owner_ack_continuation` / `strong_proxy`: a trigger-conditioned turn followed by a short acknowledgement such as "proceed" or "ok".
  - `owner_goal_directive` / `moderate_proxy`: the next message assigned a new goal.
  - `owner_next_request` / `moderate_proxy`: the next message moved to a different substantive request; this does not prove the previous turn was complete.
  - `operator_feedback_recorded` / `operator_feedback_proxy_unverified`: one anchor comes from recorded operator feedback whose source row has `auto = false`; the author is unverified and the strength is proxy-only, not human-verified ground truth.
  The raw next message and the private source mapping are not published.

## Selection and composition

Source families (candidate-selection families, not labels):

| Family | Records | Meaning |
| --- | --- | --- |
| Corpus negative candidate | 77 | The next message moved to another request (weak completion signal). |
| Trigger-conditioned | 12 | The next message was an acknowledgement/continuation or a goal directive. |
| Corpus continuation-positive | 10 | The next message was an explicit continue/proceed nudge. |
| Operator-feedback anchor | 1 | Recorded operator feedback with an unverified author and proxy strength. |

Response-shape mix (selection diversity only): `other_report` 36, `short_status` 19, `completion_report` 17, `remaining_or_announce` 13, `blocker_or_wait` 9, `ends_question` 6.

Request length: min 40 / median 102 / max 839; final length: min 40 / median 354 / max 930.

## Deidentification

Every pair is transformed deterministically from its private original:

- Absolute home/system paths, repository paths, and file names become `[REPO_PATH]`, `[SYSTEM_PATH]`, or `[FILE]`.
- Commit SHAs, branch/worktree names, issue/PR numbers, session/request ids, UUIDs, and opaque revisions become `[COMMIT]`, `[BRANCH]`, `[WORKTREE]`, `[ISSUE]`, or `[ID]`.
- Owner/organization/product identities become `[ORG]`, `[SERVICE]`, or `[USER]`; provider and model codenames become `[PROVIDER]` and `[MODEL]`; deployment ids become `[DEPLOYMENT]`; code identifiers become `[IDENTIFIER]`; e-mails become `[USER_EMAIL]`; handles become `[USER]`.
- Private or loopback URLs become `[PRIVATE_URL]` or `[LOCAL_URL]`.
- Nine rows received review-driven functional entity substitutions after blind review; all other reviewed text is byte-for-byte the frozen reviewed text, and substitutions preserve the task-to-response relationship, grammar, and completion evidence.
- Edit categories used: commit 18, markdown link 16, identity 13, file 12, branch 9, issue 7, URL 4, home path 4, model 2, UUID 2, bold issue 1, deployment 1, identifier 1, local URL 1, handle 1, provider 1, repo path 1, system path 1, worktree 1.

## Exclusions and bias

The private build excluded rows before and during review (no source text published):

| Reason | Rows |
| --- | --- |
| Outside the 40/900/1200 windows (or too short) | 2188 |
| Security/auth topics | 511 |
| Private-business topics | 505 |
| Private-infrastructure topics | 339 |
| Personal topics | 285 |
| Financial topics | 247 |
| Code fences, then other code-heavy rows | 262 |
| Writer row-level privacy/meaning review drops | 96 |
| Duplicate normalized pairs | 33 |
| Medical / third-party-data topics | 17 |
| Residual identifier hits after substitution | 11 |
| Credential patterns (assignment, cookie, password, keys) | 9 |
| Post-review drops (insufficient pair context, financial vertical) | 5 |

Bias is real and should be stated when results are reported:

- Privacy filtering removed long implementation transcripts that embed code, paths, hosts, and private business context, so short engineering/status and Q&A endings are over-represented.
- Personal, medical, financial, security, private-business, and code-heavy endings are absent rather than deidentified; the corpus does not represent those turn types.
- The continuation-positive source pool was small (10 threads) before labelling, but the blind review found 26 `authorized_unfinished`, 16 `waiting`, and 1 `unclear` record, so the four-way task is represented without being balanced.
- Labels are one independent agent review with recorded confidence (54 high / 46 medium); expect annotation noise, especially between `waiting` and `authorized_unfinished`.
- No model training or fine-tuning was performed by this export, and no accuracy gain is claimed. Any metric must be regenerated on the frozen files and reported with its thresholds.

## Reproducibility

- The raw private corpora, the source mapping, and the pre-review draft are not published; third parties can verify the schema, splits, distributions, and absence of credential/identity patterns, but cannot re-derive the originals from this repository alone.
- `validate.ts` re-checks every published byte's schema and privacy classes and must exit 0 before release; it is read-only, makes no network or model call, and accepts no flags.

## Evaluation path

The existing scorer consumes this schema directly (same 900/1200 windows, exact `work` choice comparison):

```sh
OPENROUTER_API_KEY=<key> python3 jev/score-rubric.py \
  --questions jev/questions-mjolnir-work.json \
  --cases jev/dataset/cases.jsonl \
  --out jev/dataset/score-latest.json
```

`jev/dataset/score*.json` is gitignored. The command is paid and requires network plus an API key; it was not executed while building this dataset. The scorer also requires a private `jev-sandbox` Python package provided outside this repository, so a fresh checkout cannot run it until that dependency and a key are available. Report choice-level results and, when thresholds are used, both 0.5 (`score-rubric.py`) and 0.56 (hook gate) explicitly; do not reuse older score files.

## Validate

```sh
deno run --allow-read jev/dataset/validate.ts
```