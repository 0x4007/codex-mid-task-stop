# Locked-reserve evaluation research code

Generic research implementation extracted from the private `locked-reserve-eval-v1` preparation; private data stays under `.publication-audit/` and is never embedded here.

- `runner-present-tense-v3.py`, `runner-work.py`, `runner-explicit-remaining.py`: three fixed one-question profiles using the existing SDK protocol (`route.apply()`, `experiment.run_json`, FIRST900 request / FIRST1200 final Unicode code points, model `jev-1.13.0`, env `OPENROUTER_API_KEY` / `JEV_CACHE`), original `--out` option only.
- `compose-locked-reserve.py`: offline composition and metric folding for `v3 >= 0.5 OR explicit_remaining >= 0.8` and `v3 >= 0.6 OR explicit_remaining >= 0.8`, with exact frozen scope id/hash-join assertions.
- `selfcheck-offline.py`: cheap schema regression that exercises the real CLI/payload path with a mocked subprocess (no provider call) plus synthetic composition folding.
- `locked-reserve-results-summary.json`: aggregated public-safe results.

The copies resolve the private fixed inputs directory relative to themselves (`.publication-audit/research-goal/locked-reserve-eval-v1/`) and fail closed when it is absent; private cases, labels, configs, captures and mappings are not published. No case text, identities, credentials, or dictionary values appear in this directory.

Run from the repository root when the private fixed inputs exist: `python3 backtest/research/locked-reserve/runner-present-tense-v3.py --out <capture.json>`; `python3 backtest/research/locked-reserve/compose-locked-reserve.py --out <composition.json>`; `python3 backtest/research/locked-reserve/selfcheck-offline.py`.

Limits: metrics are conditional on frozen same-model independent-agent-review proxy labels, not human truth or gold labels; the 24-row sample is not an at-scale reliability estimate; four prior-split rows are excluded from the independent-heldout claim (three proven train proposer-input exposure, one exposure-provisional); two rows were privacy-quarantined and never called; the `explicit_remaining` snapshot is `frozen_current_explicit_remaining_snapshot`, not proven exact historical B; no Noul/Choice probability equivalence; no live promotion.
