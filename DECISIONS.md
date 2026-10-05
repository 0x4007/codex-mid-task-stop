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

## Private backtesting sandbox (2026-10-04)

- `backtest/` is a replay-only sandbox, not a live rollout: it never installs hooks or edits live config, and all raw snapshots, source mappings, caches and results stay under the ignored `.publication-audit/backtesting/` path.
- Improvement is question/policy optimization only, using the original teaching mechanism (a bounded instruction-or-criteria sentence plus the caller floor). No weights, fine-tuning, new examples, primitive/id/model change, or accuracy claim is made.
- The collector freezes only local root-user transcripts, archived zst, and DB message data whose turn pointers resolve; coverage is reported exactly, the Mac/other-host gap is named, and no all-devices claim is made. Only locally verified child/observer/current-incomplete turns, duplicate carriers, reasoning, and bootstrap AGENTS text are excluded; DB-only source origin can remain unknown and is carried explicitly as `root_or_child_unverifiable_from_db_alone`; those rows form a separate private experimental cohort and must be excluded from claims requiring confirmed user-root provenance.
- The candidate proposer sees train/dev only; the locked heldout split is evaluation-only. Promotion keeps the current question unless dev improves and the locked-heldout non-regression / false-resume gate passes; provider errors abort without a metric.
- Blind annotation uses an immutable queue with no prior labels, secrets, source ids, or future-user signals; reviewer labels enter only through an accepted cached batch and carry `independent_agent_review` provenance, never human annotation or ground truth.

## Research branch coordination (2026-10-05)

- `research/vps-backtest` is intentionally unmerged at base `92482a8a3fadff1748ebff2cde8894ba685d88a0`; `main` stays stable, and no merge or live hook/config change happens until Mac/VPS coordination.
- The VPS owns `backtest/`; the Mac holds concurrent richer data, and the VPS independently reproduced the exact v3 public50 probe at floors 0.5/0.6 with waiting false-resume 1/10 and 0/10 ([research report](docs/VPS_PROBE_RESEARCH.md)).
- Before any merge, preserve the frozen public heldout split and validate the exact probe/question revision, model, state windows, threshold, per-case predictions, and caches; prioritize stronger `waiting` evidence and agree source ownership, shared runner, and model interfaces.
- Published claims reference only the public dataset paths (`jev/dataset/cases.jsonl`, `jev/dataset/splits.json`, `jev/dataset/DATASET.md`, `jev/dataset/validate.ts`); private raw sessions, snapshots, caches, champion state, reviewer logs, and the literal privacy dictionary are never republished.

## Frozen present-tense Noul comparator (2026-10-05)

- `backtest/questions-present-tense-v3.json` is a byte-exact public copy (SHA-256 `7c63f7932901782f75223d677189e806a915dd2096b05667cf23f2d112f77beb`) of the frozen optional Noul comparator scored by the VPS present-tense research replays; details and limits are in `docs/VPS_PROBE_RESEARCH.md`.
- Recorded exception: research replays may score this standalone frozen comparator on frozen cohorts, but it is not support in the existing Choice optimizer, not a promoted champion, and never a live/default question or hook change; no weights, training, or live switch results from it.
- The existing default Choice optimization policy is unchanged; the VPS owns `backtest/`, the Mac owns `jev/`, and private inputs, reviewer logs, and provenance mappings stay private. No merge or runtime deployment is implied.
