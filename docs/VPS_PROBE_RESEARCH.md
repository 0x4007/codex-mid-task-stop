# VPS present-tense Noul comparator research

Research milestone on `research/vps-backtest` at `9091773499f528ecf4055998b567f69e856e940e`. This is not a completion claim and not a deployed runtime: nothing here changes the live hook, the default question, or live configuration, and the branch stays unmerged pending Mac/VPS coordination.

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

## Replay and evidence discipline

- Four fresh SDK logical evaluations totalled 109 cases (50 + 19 + 18 + 22); estimated input-priced cost is about USD 0.004734 at the frozen 0.042 USD/M assumption, which is a configuration estimate and not a provider billing receipt.
- Each identical replay bought zero tokens when the actual result was available; only answers, probabilities, and decisions are asserted identical, while cache, millisecond, and token metadata are expected to differ. No fresh-provider determinism is claimed.
- Root capture evidence: 20/20 tests exit 0 (host-local ref `1c1ee2…`, run `61f96c44-0f81-4a80-93ea-91a7f54c6e5a`, duration 40.614 s), covering the Unicode queue-window fix to code points plus cap+1 overflow and BMP boundary regressions.
- Root lint (host-local ref `fb17a517-e215-4d23-ac78-92d099f9b001`) exits 1 with 2 preexisting `require-await` findings present at pristine HEAD; lint is not claimed green.
- Host-local receipt identifiers are listed for traceability only and are not portable verification.

## Limits and next steps

- The present-tense question leads only in the small paired VPS cohort, and Mac recall (0/2 resume labels caught) means no promotion and no live switch.
- Mac22 is a selected pool after reviews, not an overall reliability estimate: label/gate binding is verified 22/22 with 44/44 reviewer verdicts, but root proof and group overlap are unknown for all 22 rows, 12 rows are db-pointer unverified, and 6 rows were labeled on full input while the provider would see the prefix.
- PRIMARY is 18 of 30 diagnostic rows; the original handpicked-18 dataset is a different case set from this new 18, and the primary scope has no waiting rows, so waiting false-resume is not estimable there.
- No human truth: label authority is independent agent review, and same-model consensus is not truth.
- Next work is validation on the new locked reserve holdout plus missed-case and input-context study; do not tune on the old held-out/diagnostic data or the filtered Mac22.
- The research goal remains active; this milestone records evidence and does not close the research.

## Public references

- Dataset: [cases.jsonl](../jev/dataset/cases.jsonl), [splits.json](../jev/dataset/splits.json), [stats.json](../jev/dataset/stats.json), [DATASET.md](../jev/dataset/DATASET.md), [validate.ts](../jev/dataset/validate.ts).
- TypeSafe Noul documentation: <https://docs.typesafe.ai/primitives/noul>.