# Public stop-guard policy upgrade (2026-10-06)

This page records the decision-policy change measured on the public reviewed 100
(`jev/dataset/cases.jsonl`), its method, its results, and its limits. It is public-safe: every
input is a tracked public dataset file, every output contains only public case ids, and no
private transcript, path, or identifier is used.

## What changed and why

The detector previously asked one `work` Choice question (Mjolnir's rubric) and continued only
when `work == authorized_unfinished` cleared the caller floor (0.56). The audit of the lineage
found two gaps a text-only probe cannot see:

1. **Mechanical unfinished shapes.** Finals that announce work ("Implementing the gate:",
   "Verifying …."), admit unperformed actions ("I haven't restored …"), state missing artifacts
   ("What is missing is …"), or lock a decision instead of doing work are read as completions by
   a language-only judge.
2. **Contradicted completion claims.** A final can claim completion ("re-running it fixed …",
   "all tests pass") while the turn's own receipts contradict it.

The upgraded policy keeps the probe but composes it with receipt facts read from the transcript:

```
continue when   probeContinue || anyTextReceipt || claimContradicted
  probeContinue   present_tense_v3 noul >= floor (default 0.6; legacy work rubric: p >= 0.56)
  anyTextReceipt  gate_unperformed_action | gate_explicit_missing | gate_in_progress_action
                  | gate_decision_locked | gate_questions_without_attempt
  claimContradicted  a completion claim in the final text contradicted by the turn's receipts
```

`supported` and `unobserved` claim states stay diagnostic in the decision log; only a
contradiction authorizes action. The one-continuation allowance and the `stop_hook_active`
stand-down are unchanged. The private lineage removed its per-turn cap; that change is
deliberately **not** ported here.

## Method

- Question: `jev/questions-present-tense-v3.json`, byte-exact copy of
  `backtest/questions-present-tense-v3.json` (SHA-256
  `7c63f7932901782f75223d677189e806a915dd2096b05667cf23f2d112f77beb`, verified before and after).
- Windows: request 900 / final 1200 Unicode code points, the same truncation the hook uses.
- Floors: probe 0.6; legacy work binary 0.56.
- Arms: `work_baseline` (fresh work Choice on all 100 rows), `probe_only` (fresh v3 on all 100
  rows), `probe_plus_receipts` (probe OR text receipts, composed with `textReceipts` from
  `jev/gates.ts`).
- Runner: `jev/score-public-policy.ts`, batch calls through the jev-sandbox python route
  (`uv run --no-sync python`, the same SDK path the hook uses), isolated caches under the
  ignored `.publication-audit/stopguard-public100/` area, abort on provider error, no fallback
  provider, never prints the key.
- Cost: 200 fresh logical calls, $0.010008 reported by the route (v3 100 calls $0.003633,
  work 100 calls $0.006375), within the authorized <= 500 calls / <= $0.15 budget.

Reproduce:

```sh
deno run --allow-read --allow-write --allow-run --allow-env jev/score-public-policy.ts --fresh --question v3
deno run --allow-read --allow-write --allow-run --allow-env jev/score-public-policy.ts --fresh --question work
deno run --allow-read --allow-write --allow-run --allow-env jev/score-public-policy.ts \
  --from-verdicts .publication-audit/stopguard-public100/verdicts-v3-fresh.json \
  --from-verdicts .publication-audit/stopguard-public100/verdicts-work-fresh.json
```

Fresh mode was **not blocked**: both arms ran live on this host, so all numbers below are fresh
provider runs, not cached re-composition. (An earlier offline composition over a cached
transfer reproduced the same 88 and 90 on probe/policy, which cross-checks the runner.)

## Results (fresh runs, identical 100 rows)

| Arm | dev 50 | heldout 50 | total 100 |
| --- | --- | --- | --- |
| `work_baseline` (work Choice, floor 0.56) | 44/50 | 41/50 | **85/100** |
| `probe_only` (v3 noul, floor 0.6) | 41/50 | 47/50 | **88/100** |
| `probe_plus_receipts` (shipped policy) | 40/50 | 50/50 | **90/100** |

Errors (public ids):

- `work_baseline` — false stops: `public-0019`, `public-0017`; false resumes: `public-0022`,
  `public-0053`, `public-0058`, `public-0073`, `public-0087`, `public-0006`, `public-0015`,
  `public-0021`, `public-0023`, `public-0051`, `public-0079`, `public-0099`, `public-0101`.
- `probe_only` — false stops: `public-0007`, `public-0013`, `public-0016`, `public-0031`,
  `public-0034`, `public-0059`, `public-0086`, `public-0033`, `public-0037`, `public-0044`;
  false resumes: `public-0012`, `public-0047`.
- `probe_plus_receipts` — false stops: `public-0007`, `public-0013`, `public-0016`,
  `public-0031`, `public-0034`, `public-0059`, `public-0086`; false resumes: `public-0012`,
  `public-0047`, `public-0058`.

The receipt arm converted three probe misses on heldout (`public-0033` in-progress action,
`public-0037` unperformed action, `public-0044` locked decision) and added one dev false resume
(`public-0058`, unperformed action on a row labelled finished). Heldout is 50/50 with the
receipts; dev drops 41 to 40.

## Receipt-class analysis (public 100)

| Class | fired | on authorized_unfinished | on other |
| --- | --- | --- | --- |
| `gate_in_progress_action` | 4 | 4 | 0 |
| `gate_decision_locked` | 2 | 2 | 0 |
| `gate_unperformed_action` | 2 | 1 | 1 |
| `gate_explicit_missing` | 0 | 0 | 0 |
| `gate_questions_without_attempt` | 0 | 0 | 0 |

Receipt flips beyond probe-only: 4 rows evaluated differently (3 correct, 1 incorrect).

## Train678 receipt false-fire diagnostic (deterministic, no model calls)

`jev/dataset/train/cases.jsonl` (678 proxy-labelled rows): receipts fired on **29 rows**
(`gate_unperformed_action` 13, `gate_in_progress_action` 11, `gate_explicit_missing` 5,
`gate_decision_locked` 1, `gate_questions_without_attempt` 0). The train split is 673 finished /
5 authorized_unfinished proxy labels, so this is a coarse false-fire upper bound on prose shape,
not an accuracy measurement.

## Limits

- Four of the five receipt classes are fitted to single residual cases from frozen sets; a
  prospective blind set is the remaining evidence step before general claims.
- Heldout was consulted across earlier iterations in the lineage; it is a regression set, not a
  blind prospective claim.
- Labels are independent blind agent review, not human annotation or ground truth.
- `claimContradicted` cannot be recomputed offline on dataset rows because they carry no
  transcripts (only the request/final pair); the live hook evaluates it from the turn's receipts,
  and the offline numbers above therefore show the composed policy without that arm.
- Only 2 of 100 rows flip on the receipt arm; the difference between 88 and 90 is within
  small-sample noise, and no confidence interval is claimed.
- Coverage is the public reviewed 100 only; no claim is made about live traffic.

## Privacy statement

All inputs are tracked public dataset files. The fresh runs sent only public row text to the
provider. Both outputs (`jev/public-policy-results.json` and the ignored run-area copy) contain
public case ids, counts, and configuration hashes only. An identifier scan over every changed and
new tracked file for absolute user-home paths, provider-key and secret-token prefixes, private
session-id forms, and the private identifier list returned zero hits. The only remaining matches
are the public hook's own documented id prefix and the provider key variable name that the fresh
runner must read; the commands and raw results are in the handback recorded for this change.
