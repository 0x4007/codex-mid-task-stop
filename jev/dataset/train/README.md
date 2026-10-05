# Jev completion dataset — training split (proxy labels)

678 sanitized transcript endings for development, built with the same topic/privacy/code filters and
the same deterministic sanitizer as the reviewed public corpus (`../cases.jsonl`). This split is
**not reviewed and not for evaluation**; use the reviewed corpus for evaluation.

- Labels are proxies: 673 `finished` / 5 `authorized_unfinished`.
  - `corpus_next_user_nudge_heuristic` 672 (the next message moved to a different request; weak proxy),
  - `user_ack_continuation` 3 (the next message was `proceed`/ack; strong proxy),
  - `corpus_stop_label` 1, `owner_feedback` 2 (owner-labelled corrections).
- Sources: `corpus.jsonl` 673, `triggers.jsonl` 3, `feedback-corpus.jsonl` 2.
- Reviewed pairs are excluded (107 overlaps removed), so no row here appears in the reviewed corpus.
- Windows: request <= 900 / final <= 1200 characters (hook-exact). Rows whose sanitized text still
  exceeded the windows were dropped, not truncated (0 truncated rows in this export).
- Privacy: same fail-closed filters (credentials, private topics, code-heavy rows) and placeholder
  sanitizer as the reviewed corpus; the export greps to zero emails, absolute home paths, token
  patterns, and UUIDs.
- Bias: same topic/code exclusions as the reviewed corpus, and positives are scarce here — the 26
  reviewed `authorized_unfinished` rows live in `../cases.jsonl`.

Files: `cases.jsonl`, `stats.json`, `validate.ts` (schema, window, duplicate, and privacy checks).
