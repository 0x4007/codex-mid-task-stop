# VPS backtest handoff: research/vps-backtest

The VPS backtesting work is ready for review on `research/vps-backtest`. It remains separate from `main`; merge decisions are deferred to Mac/VPS coordination.

## Branch state and ownership

- `research/vps-backtest` is intentionally unmerged at base `92482a8a3fadff1748ebff2cde8894ba685d88a0`; `main` stays at `92482a8a3fadff1748ebff2cde8894ba685d88a0` and stays stable, with no merge and no live hook or live config change until Mac/VPS coordination.
- The VPS owns the `backtest/` sandbox source; the Mac holds concurrent richer data per the user note, and Mac-side richer data must not be overwritten, replaced, or published from this side.
- The audited publication candidate is `.gitignore`, `DECISIONS.md`, `README.md`, the entire `backtest/` tree, and this handoff document under `docs/`.
- This branch starts from sanitized public `main`; original private history remains outside the public graph. Mac research branches should also use the sanitized public base.

## Actual VPS results (private backtesting ACCEPTANCE.json/md)

| Measure | VPS acceptance result |
| --- | --- |
| Frozen public heldout50 original binary agreement | auto 37/50, pre-feedback 38/50, hand-refined 40/50 |
| Automated candidate binary agreement | 41/50 |
| Exact four-way agreement | baseline 37, candidate 39 (per acceptance summary) |
| False resume | baseline 9, candidate 8 |
| Waiting false-resume | 8/10 remains |
| Focused tests | 19 focused tests passed (evidence recorded; not rerun for this handoff) |
| Identical cached replay | 375 logical requests, 375 replayed, 0 paid calls, 0 bought input tokens |
| Fresh local independent labels | 11 accepted: 6 dev and 5 heldout |
| DB-origin provenance | 5 local cases are root/child-unverified from the DB alone |
| Local gate metrics | baseline exact 4/5, candidate exact 3/5, binary accuracy 0.8 both |

- Known limits: source and private-corpus configuration is not portable as-is because fixed absolute private paths live in `backtest/lib/config.ts` and the recorded root commands; new-session labeling stays a manual reviewed queue that root runs; a persisted champion continuation can reach the 400 logical-request cap and abort safely.
- These are sandbox replay results over private sessions, not a live rollout and not an accuracy claim; nothing here installs a hook or edits live configuration.

## Mac user-reported results (reported, not independently verified by the VPS)

- The Mac reports a present-tense probe at 46-47/50 with caller floors 0.5/0.6 and waiting false-resume at 0-1/10.
- These values are user-reported only; the VPS has not reproduced them, and this handoff deliberately invents no exact SHA, model revision, or state windows for them.

## Merge contract before any merge

- Preserve the fixed public heldout split; do not retune, regenerate, or refit it for a merge.
- Validate the exact probe/question revision, model, state windows, caller threshold, per-case predictions, and caches on both sides before merging.
- Prioritize stronger `waiting` evidence, because the remaining waiting false-resume (VPS 8/10) is the weakest measured area.
- Coordinate source ownership, the shared runner, and model interfaces between VPS and Mac before any merge.

## Publication and data boundaries

- Public benchmark references are the public dataset paths `jev/dataset/cases.jsonl`, `jev/dataset/splits.json`, `jev/dataset/stats.json`, `jev/dataset/DATASET.md`, and `jev/dataset/validate.ts`.
- Do not duplicate or raw-publish private inference outputs or cases that already sit outside the public dataset; private raw sessions, snapshots, source mappings, caches, champion state, reviewer annotations, and review logs stay under the ignored `.publication-audit/` path.
- The literal privacy dictionary stays private and untracked under the ignored `.publication-audit/backtesting/` tree (the v3 role table is read only from there); public source carries only the general pattern guard and role placeholders.
- The root commits and pushes only the dedicated `research/vps-backtest` branch after acceptance; no passed test or model call needs rerunning for Git delivery.

## Audit verdict

- All 21 planned publication files were read fully and scanned read-only with the frozen credential-audit rules adapted for the worktree: one finding, the fabricated PEM marker fixture at `backtest/test.ts:278` with no key body, classified benign; no known-secret fingerprint from the parent credential report matched, and no credential, private key, session cookie, DSN, raw private transcript, provenance map, literal internal identity, or copied private code is present.
- The publication audit passed. Implementation files match the tested VPS candidate; private research artifacts are excluded.
