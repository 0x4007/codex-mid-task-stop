# Decisions

Durable decisions for this repository. Keep entries short; link to the artifact that carries the detail.

## Public dataset boundaries (2026-10-04)

- `jev/dataset/` publishes a 100-record reviewed corpus of deidentified real transcript pairs. The raw corpora (`jev/corpus.jsonl`, `jev/truth.jsonl`, `jev/triggers.jsonl`, `jev/feedback-corpus.jsonl`), the private source mapping, and the pre-review draft are never published; they remain gitignored local data.
- Labels come from an independent blind agent review (`label_authority = independent_agent_review`) and are not derived from mechanical heuristics, detector output, or scoring files; the `truth.jsonl` zero-tool-call labels are quarantined and are never training targets. Agent review is not human annotation or ground truth, and no record claims human or owner-verified authority.
- The single operator-feedback anchor is disclosed as recorded operator feedback with an unverified author and proxy-only strength (`operator_feedback_recorded` / `operator_feedback_proxy_unverified`); its source row proves only `auto = false`, which does not establish human entry.
- Five reviewed rows were dropped (four for insufficient pair context, one financial-product vertical) instead of being relabelled; review-driven functional entity substitutions were applied to nine rows while the remaining reviewed text stayed byte-for-byte unchanged.
- `dev` examples may support prompt, rubric, and teaching-material refinement; `heldout` examples are evaluation-only. This export performs no model training or fine-tuning and claims no accuracy gain.
- No synthetic conversations and no fabricated `waiting`/`unclear` rows are published; coverage bias and the small continuation-positive source pool are disclosed in `jev/dataset/DATASET.md`.
- The public validator contains no private identity allowlist, performs no network or model call, accepts no flags, and fails closed on credential, identifier, deployment-id, bold-issue-number, and private-path patterns.