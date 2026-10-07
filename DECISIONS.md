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
- Recorded exception: research replays may score this standalone frozen comparator on frozen cohorts, but it is not support in the existing Choice optimizer, not a promoted champion, and never a live/default question or hook change; no weights, training, or live switch results from it. (Superseded 2026-10-06 by the public policy upgrade below: v3 is now the live default question of the public hook.)
- The existing default Choice optimization policy is unchanged; the VPS owns `backtest/`, the Mac owns `jev/`, and private inputs, reviewer logs, and provenance mappings stay private. No merge or runtime deployment is implied. (The 2026-10-06 public policy entry records a separate, public-repo-only decision made after this line.)

## Locked-reserve evaluation publication (2026-10-05)

- The frozen 24-row locked reserve was scored on the three fixed one-question profiles (`present_tense_v3`, `work`, `explicit_remaining`) with 22 privacy-callable rows, 2 privacy quarantines, 8 ambiguous rows, and 4 prior-split rows excluded from the 12-row independent-heldout claim; conditional proxy-label accuracy is 14/15 primary and 11/12 independent for `present_tense_v3`, with the deployed Choice binary at 13/15 and 10/12.
- `backtest/questions-remaining-work.json` is a byte-exact public copy (SHA-256 `bfa96cf40e15522a0eeb8bb718d2f8512e2b1a79a4815807fff926de45a39493`) of the frozen current explicit-remaining snapshot, labeled `frozen_current_explicit_remaining_snapshot` and not proven exact historical B; it detected 0 of 2 positives at floor 0.8 and did not improve the primary or independent results.
- Generic research code and aggregated public-safe results are published under `backtest/research/locked-reserve/` (three-profile runners, offline composer with exact frozen scope assertions, schema regression, results summary); private cases, labels, mappings, configs, caches, and the literal privacy dictionary remain unpublished under ignored `.publication-audit/`.
- No human truth, no at-scale reliability claim, no Noul/Choice probability equivalence, and no live/default/hook promotion; the R&D phase is complete with these limitations and no further experiments or tuning are planned.

## Public policy upgrade: present-tense probe + receipts (2026-10-06)

- The public repo's stop-guard policy advances from the probe-only `work` Choice policy to `probe_plus_receipts`: continue when the `present_tense_v3` Noul clears its floor (default 0.6), **or** any mechanical text receipt fires (`gate_unperformed_action`, `gate_explicit_missing`, `gate_in_progress_action`, `gate_decision_locked`, `gate_questions_without_attempt`), **or** a completion claim in the final text is contradicted by the turn's receipts (`claimContradicted`; supported/unobserved stay diagnostic). Floors: `CODEX_STOP_GUARD_PROBE_FLOOR` -> `CODEX_STOP_GUARD_MIN_PROBABILITY` -> `CODEX_STOP_GUARD_MIN_CONFIDENCE` -> 0.6; the legacy work rubric keeps 0.56 and is selected with `CODEX_STOP_GUARD_RUBRIC=work`.
- `jev/questions-present-tense-v3.json` is the live default question, a byte-exact copy of the already-published `backtest/questions-present-tense-v3.json` (SHA-256 `7c63f7932901782f75223d677189e806a915dd2096b05667cf23f2d112f77beb`, verified before and after copy). `backtest/` remains VPS-owned and untouched.
- Deliberate divergence from the private lineage: this repo keeps the one-continuation allowance and the `stop_hook_active` stand-down exactly as before; the lineage's no-cap/per-turn-cap behavior, `continuationsUsed`, and `MAX_CONTINUATIONS_PER_TURN` are not ported.
- Run paths are parameterized so no machine-specific path is baked in: `REPO` stays resolved from `import.meta.url` (plus new `CODEX_STOP_GUARD_REPO`), `JEV_REPO` keeps its `${HOME}` default (plus `CODEX_STOP_GUARD_JEV_REPO`), and the new `CODEX_STOP_GUARD_UV` selects the uv executable.
- Evidence command: `deno run --allow-read --allow-write --allow-run --allow-env jev/score-public-policy.ts --fresh --question v3` and `--question work`, then compose with `--from-verdicts` over `.publication-audit/stopguard-public100/verdicts-{v3,work}-fresh.json`. Fresh measured results: shipped policy 90/100 (dev 40/50, heldout 50/50), probe-only 88/100, work baseline 85/100; 200 fresh calls, $0.010008; all inputs public; details and limits in `docs/PUBLIC_POLICY.md`.
- Limits: four of five receipt classes are fitted to single residual cases from frozen sets and await a prospective blind set; heldout was consulted across earlier iterations and is a regression set, not a blind claim; labels are agent review, not human truth; `claimContradicted` cannot be recomputed offline on dataset rows because they carry no transcripts; no private identifiers, metrics, paths, or session ids appear in any tracked artifact (identifier scan result in the handback).
