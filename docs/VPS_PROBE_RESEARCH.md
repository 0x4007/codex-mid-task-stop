# VPS present-tense Noul comparator research

Experiments for this report began at base `9091773499f528ecf4055998b567f69e856e940e` on `research/vps-backtest` and continued through additive research commits. This is not a completion claim and not a deployed runtime: nothing here changes the live hook, the default question, or live configuration, and `main` stays stable.

## Comparator

- Frozen standalone Noul question `present_tense_v3` (`type: noul`), question SHA-256 `7c63f7932901782f75223d677189e806a915dd2096b05667cf23f2d112f77beb`, published byte-exact as [`backtest/questions-present-tense-v3.json`](../backtest/questions-present-tense-v3.json).
- Judgement rule: a closing that names present-tense pending action is true; a completed report, an answer, a limitation, or a design-decision closing is false (full question and criteria live in the file).
- Model route `jev-1.13.0`; state windows first 900 request / first 1200 final Unicode code points; caller floors 0.5 and 0.6.
- Optional frozen research comparator only: a Noul probability is not a Choice probability, there is no probability equivalence, and this is neither support in the Choice optimizer nor a promoted champion. No weights, no training, no live switch; the existing default Choice optimization policy in [DECISIONS.md](../DECISIONS.md) is unchanged.
- VPS owns `backtest/`; Mac owns `jev/`. The comparator and its replays are additive research artifacts.

## Results

Frozen public heldout50, replaying the Mac present-tense probe question on the VPS:

| Floor | TP | FP | FN | TN | Correct | Waiting false-resume |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5 | 9 | 2 | 2 | 37 | 46/50 | 1/10 |
| 0.6 | 8 | 0 | 3 | 39 | 47/50 | 0/10 |

New VPS diagnostic cohort (30 rows; PRIMARY 18 scored at both floors):

| Floor | Scope | TP | FP | FN | TN | Correct |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5 | PRIMARY 18 | 4 | 0 | 1 | 13 | 17/18 |
| 0.6 | PRIMARY 18 | 4 | 0 | 1 | 13 | 17/18 |

Deployed Choice baseline at its actual floor 0.56, scoped to the same frozen 18 rows: TP 3, FP 1, FN 2, TN 12, correct 15/18, four-way choice agreement 15/18.

Mac selected 22 (v8/v9 iterative-review selected pool, 10 + 12 rows):

| Floor | TP | FP | FN | TN | Correct | Resume labels caught |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5 | 0 | 1 | 2 | 19 | 19/22 | 0/2 |
| 0.6 | 0 | 0 | 2 | 20 | 20/22 | 0/2 |

Prefix review over the 30 diagnostic rows:

- Reviewer agreement is 29/30 with kappa 0.9429; 18/30 pass the frozen privacy and context gates and form PRIMARY.
- 7 prior privacy quarantines were kept, and 5 prefix-waiting rows were gated out; one ambiguously labeled secondary row is reported separately and is not added to the primary denominator.
- 60 reserve rows stay untouched (unlabeled, unpredicted); 90 unique VPS groups = 30 diagnostic + 60 reserve.
- The 10/30 diagnostic rows whose fields were not byte-equal to the production prefix projection were corrected by a re-export of the prefix view, additively: prior artifact hashes are unchanged and prior labels are preserved.
- Earlier window/context reviewer statistics and view drift are tracked separately from classification, and no human truth is claimed anywhere.

## Locked-reserve evaluation (frozen 24-case new heldout)

Conditional on the frozen same-model proxy labels, `present_tense_v3` scored 14/15 (93.3%) on the privacy-scored primary context set and 11/12 (91.7%) on the independent-heldout subset at floors 0.5 and 0.6; the deployed Choice binary at floor 0.56 scored 13/15 (86.7%) and 10/12 (83.3%), and the prefix-view proxy (nonprimary diagnostic) scored 15/16 (93.8%). These are conditional proxy-label results, not gold or human-truth accuracy.

| Scope | Arm | n | TP | FP | FN | TN | Correct | Waiting false-resume |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PRIMARY context proxy | v3 floor 0.5 | 15 | 1 | 0 | 1 | 13 | 14/15 | 0/1 |
| PRIMARY context proxy | v3 floor 0.6 | 15 | 1 | 0 | 1 | 13 | 14/15 | 0/1 |
| PRIMARY context proxy | explicit_remaining floor 0.8 | 15 | 0 | 0 | 2 | 13 | 13/15 | 0/1 |
| PRIMARY context proxy | Choice floor 0.56 | 15 | 2 | 2 | 0 | 11 | 13/15 | 1/1 |
| PRIMARY independent 12 | v3 floor 0.5 | 12 | 1 | 0 | 1 | 10 | 11/12 | 0/1 |
| PRIMARY independent 12 | v3 floor 0.6 | 12 | 1 | 0 | 1 | 10 | 11/12 | 0/1 |
| PRIMARY independent 12 | explicit_remaining floor 0.8 | 12 | 0 | 0 | 2 | 10 | 10/12 | 0/1 |
| PRIMARY independent 12 | Choice floor 0.56 | 12 | 2 | 2 | 0 | 8 | 10/12 | 1/1 |
| PREFIX proxy (nonprimary) | v3 floor 0.5/0.6 | 16 | 1 | 0 | 1 | 14 | 15/16 | 0/1 |
| PREFIX proxy (nonprimary) | Choice floor 0.56 | 16 | 2 | 2 | 0 | 12 | 14/16 | 1/1 |

Standalone, the frozen `explicit_remaining` snapshot scored 13/15 on the primary 15 and 10/12 on the independent 12 at floor 0.8, detecting 0 of 2 unfinished positives; the fixed OR compositions (`v3 >= 0.5 OR explicit_remaining >= 0.8` and `v3 >= 0.6 OR explicit_remaining >= 0.8`) stay at the v3-only 14/15 and 11/12, detecting 1 of 2 unfinished positives and 0/1 waiting false-resumes.

The 24 sampled rows are not a gold set: 22 were privacy-callable, 2 were privacy-quarantined and never called, 8 were ambiguous and never scored as accuracy, and 4 prior-split rows are excluded from the independent-heldout claim (three proven train proposer-input exposure, one exposure-provisional); the claim therefore covers 12 of 24 rows, not all 24.

Proxy agreement on the locked reserve was 17/24 (kappa 0.494) on the prefix view and 20/24 (kappa 0.692) on the context view; the independent subset uses the exact frozen 12-row membership and the same frozen context labels.

## Replay and evidence discipline

- Seven fresh SDK logical evaluations totalled 175 cases (50 + 19 + 18 + 22 plus the three 22-case locked profiles); estimated input-priced cost is about USD 0.007777 at the frozen 0.042 USD/M assumption, which is a configuration estimate and not a provider billing receipt.
- Each identical replay bought zero tokens when the actual result was available; only answers, probabilities, and decisions are asserted identical, while cache, millisecond, and token metadata are expected to differ. No fresh-provider determinism is claimed; the three locked-profile replays (66 logical replays of 22 cases each) bought zero tokens and reproduced identical answers.
- Root capture evidence: 20/20 tests exit 0 (host-local ref `1c1ee2…`, run `61f96c44-0f81-4a80-93ea-91a7f54c6e5a`, duration 40.614 s), covering the Unicode queue-window fix to code points plus cap+1 overflow and BMP boundary regressions.
- Root lint (host-local ref `fb17a517-e215-4d23-ac78-92d099f9b001`) exits 1 with 2 preexisting `require-await` findings present at pristine HEAD; lint is not claimed green.
- Host-local receipt identifiers are listed for traceability only and are not portable verification.

## Limits and next steps

- The present-tense question leads only in the small paired VPS cohort, and Mac recall (0/2 resume labels caught) means no promotion and no live switch.
- Mac22 is a selected pool after reviews, not an overall reliability estimate: label/gate binding is verified 22/22 with 44/44 reviewer verdicts, but root proof and group overlap are unknown for all 22 rows, 12 rows are db-pointer unverified, and 6 rows were labeled on full input while the provider would see the prefix.
- PRIMARY is 18 of 30 diagnostic rows; the original handpicked-18 dataset is a different case set from this new 18, and the primary scope has no waiting rows, so waiting false-resume is not estimable there.
- The locked-reserve sample is 24 rows, not a gold set: 22 were privacy-callable, 2 were privacy-quarantined and never called, 8 were ambiguous and never scored as accuracy, and 4 prior-split rows are excluded from the 12-row independent-heldout claim (three proven train proposer-input exposure, one exposure-provisional); no at-scale reliability is claimed.
- The current `explicit_remaining` snapshot is frozen as `frozen_current_explicit_remaining_snapshot`, not proven exact historical B; standalone at floor 0.8 it scored 13/15 primary and 10/12 independent with 0 of 2 unfinished positives, while the OR compositions remained at 14/15 and 11/12 (1 of 2 unfinished positives, 0/1 waiting false-resume); no historical-B identity and no promotion are claimed.
- No human truth: label authority is independent agent review, and same-model consensus is not truth.
- The R&D phase is complete with these limitations; no further experiments, tuning, collection, label changes, or promotion are planned, and `main` remains stable.

## Public references

- Dataset: [cases.jsonl](../jev/dataset/cases.jsonl), [splits.json](../jev/dataset/splits.json), [stats.json](../jev/dataset/stats.json), [DATASET.md](../jev/dataset/DATASET.md), [validate.ts](../jev/dataset/validate.ts).
- Locked-reserve research code and aggregates: [backtest/research/locked-reserve/README.md](../backtest/research/locked-reserve/README.md), [locked-reserve-results-summary.json](../backtest/research/locked-reserve/locked-reserve-results-summary.json), [questions-remaining-work.json](../backtest/questions-remaining-work.json).
- TypeSafe Noul documentation: <https://docs.typesafe.ai/primitives/noul>.