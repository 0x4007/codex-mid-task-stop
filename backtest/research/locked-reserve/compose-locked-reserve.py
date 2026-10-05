#!/usr/bin/env python3
"""Offline composition postprocessor for locked-reserve-eval-v1.

Reads the three fixed capture result files produced by the root relay, joins them
by exact case_id + prefix_pair_sha256 + state_window_sha256, and folds the fixed
experimental compositions offline:

    v3 >= 0.5 OR explicit_remaining >= 0.8
    v3 >= 0.6 OR explicit_remaining >= 0.8

Metrics are reported against the frozen PRIMARY_CONTEXT_PROXY (and the
independent-heldout subset) and separately against the PREFIX_PROXY as
nonprimary diagnostics. The full 24-row denominator is always preserved; the
four exposure-provisional rows are excluded only from primary-independent
claims. No accuracy is scored for ambiguous rows. Writes only through --out.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PRIVATE_INPUTS = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".publication-audit", "research-goal", "locked-reserve-eval-v1"))
HERE = _PRIVATE_INPUTS if os.path.isdir(_PRIVATE_INPUTS) else _HERE
CAPTURES = {
    "present_tense_v3": "results-present-tense-v3-capture.json",
    "work": "results-work-choice-capture.json",
    "explicit_remaining": "results-explicit-remaining-capture.json",
}
REPLAYS = {
    "present_tense_v3": "results-present-tense-v3-replay.json",
    "work": "results-work-choice-replay.json",
    "explicit_remaining": "results-explicit-remaining-replay.json",
}
COMPOSITIONS = [
    ("composition_v3_ge_0.5_or_explicit_ge_0.8", [("present_tense_v3", 0.5), ("explicit_remaining", 0.8)]),
    ("composition_v3_ge_0.6_or_explicit_ge_0.8", [("present_tense_v3", 0.6), ("explicit_remaining", 0.8)]),
]


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def decision_noul(result, threshold):
    d = result.get("decision") or {}
    if d.get("kind") != "noul":
        return None
    return bool(d.get("decisions", {}).get(str(threshold), False))


def decision_choice(result):
    d = result.get("decision") or {}
    if d.get("kind") != "choice":
        return None
    return bool(d.get("resume_runtime"))


def metrics(rows, key):
    tp = fp = fn = tn = 0
    waiting_n = waiting_resume = 0
    for r in rows:
        label = r["label"]
        pred = r[key]
        if pred is None:
            continue
        positive = label == "authorized_unfinished"
        if pred and positive:
            tp += 1
        elif pred and not positive:
            fp += 1
        elif not pred and positive:
            fn += 1
        else:
            tn += 1
        if label == "waiting":
            waiting_n += 1
            waiting_resume += int(pred)
    n = tp + fp + fn + tn
    return {
        "n": n, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "accuracy": round((tp + tn) / n, 6) if n else None,
        "positive_n": tp + fn,
        "waiting_n": waiting_n,
        "waiting_false_resume": waiting_resume,
        "waiting_false_resume_rate": round(waiting_resume / waiting_n, 6) if waiting_n else None,
    }


def build_rows(captures):
    per_case = {}
    for qid, cap in captures.items():
        for r in cap["results"]:
            per_case.setdefault(r["id"], {})[qid] = r
    rows = []
    for cid in sorted(per_case):
        r = per_case[cid]
        if "present_tense_v3" not in r:
            continue
        base = r["present_tense_v3"]
        row = {
            "case_id": cid,
            "label": base.get("primary_context_proxy_label"),
            "prefix_label": base.get("prefix_proxy_label"),
            "prefix_pair_sha256": base["prefix_pair_sha256"],
            "state_window_sha256": base["state_window_sha256"],
            "provider_call_allowed": base.get("provider_call_allowed"),
            "primary_independent_heldout": base.get("primary_independent_heldout"),
            "exposure_status": base.get("exposure_status"),
            "input_row_sha256": base.get("input_row_sha256"),
            "v3_0.5": decision_noul(r.get("present_tense_v3", {}), 0.5),
            "v3_0.6": decision_noul(r.get("present_tense_v3", {}), 0.6),
            "explicit_0.8": decision_noul(r.get("explicit_remaining", {}), 0.8),
            "work_0.56": decision_choice(r.get("work", {})),
        }
        for name, terms in COMPOSITIONS:
            votes = [row[f"{qid.replace('present_tense_v3', 'v3').replace('explicit_remaining', 'explicit')}_{th}"] for qid, th in terms]
            votes = [v for v in votes if v is not None]
            row[name] = bool(any(votes)) if votes else None
        rows.append(row)
    return rows


def joined_integrity(rows, captures):
    problems = []
    for row in rows:
        for qid, cap in captures.items():
            match = next((x for x in cap["results"] if x["id"] == row["case_id"]), None)
            if match is None:
                continue
            if match["prefix_pair_sha256"] != row["prefix_pair_sha256"]:
                problems.append(f"{row['case_id']}:{qid}:pair")
            if match["state_window_sha256"] != row["state_window_sha256"]:
                problems.append(f"{row['case_id']}:{qid}:window")
    return problems


def load_captures():
    captures = {}
    missing = []
    for qid, name in CAPTURES.items():
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            missing.append(name)
        else:
            captures[qid] = load(path)
    return captures, missing


def scope_digest(case_ids):
    import hashlib
    return hashlib.sha256("\n".join(sorted(case_ids)).encode("utf-8")).hexdigest()


def frozen_scope_sets():
    """Exact frozen scope membership from the private cases file (fail closed if absent)."""
    path = os.path.join(HERE, "cases-locked-reserve-24.private.jsonl")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        cases = [json.loads(line) for line in fh if line.strip()]
    by_case = {c["case_id"]: c for c in cases}
    primary = {c["case_id"] for c in cases if c["primary_context_proxy_defined"] and c["provider_call_allowed"]}
    independent = {c["case_id"] for c in cases if c["primary_independent_heldout"]}
    prefix = {c["case_id"] for c in cases if c["prefix_proxy_defined"] and c["provider_call_allowed"]}
    return by_case, primary, independent, prefix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    captures, missing = load_captures()
    if missing:
        print("missing captures: " + ", ".join(missing), file=sys.stderr)
        return 2
    rows = build_rows(captures)
    problems = joined_integrity(rows, captures)
    if problems:
        print("hash join problems: " + ", ".join(problems[:10]), file=sys.stderr)
        return 2
    primary = [r for r in rows if r["label"] is not None and r["provider_call_allowed"]]
    independent = [r for r in rows if r["label"] is not None and r["provider_call_allowed"]
                   and r.get("primary_independent_heldout")]
    prefix = [r for r in rows if r["prefix_label"] is not None and r["provider_call_allowed"]]
    frozen = frozen_scope_sets()
    if frozen is None:
        print("frozen private cases file required for exact scope assertions", file=sys.stderr)
        return 2
    by_case, exp_primary, exp_independent, exp_prefix = frozen
    if not exp_independent <= exp_primary:
        print("frozen independent scope is not a subset of the primary scope", file=sys.stderr)
        return 2
    for name, scope_rows, expected, label_key in (
        ("primary", primary, exp_primary, "primary_context_proxy_label"),
        ("independent", independent, exp_independent, "primary_context_proxy_label"),
        ("prefix", prefix, exp_prefix, "prefix_proxy_label"),
    ):
        actual = {r["case_id"] for r in scope_rows}
        if actual != expected or len(scope_rows) != len(expected):
            print(f"scope {name} mismatch: n={len(scope_rows)} expected={len(expected)}", file=sys.stderr)
            return 2
        for r in scope_rows:
            case = by_case[r["case_id"]]
            if (r["prefix_pair_sha256"] != case["prefix_pair_sha256"]
                    or r["state_window_sha256"] != case["state_window_sha256"]
                    or r.get("input_row_sha256") != case["input_row_sha256"]):
                print(f"scope {name} hash join mismatch for {r['case_id']}", file=sys.stderr)
                return 2
            if r["label" if label_key == "primary_context_proxy_label" else "prefix_label"] != case[label_key]:
                print(f"scope {name} label mismatch for {r['case_id']}", file=sys.stderr)
                return 2
    keys = ["v3_0.5", "v3_0.6", "explicit_0.8", "work_0.56"] + [c[0] for c in COMPOSITIONS]
    report = {
        "schema": "locked-reserve-compose/v1",
        "full_denominator": 24,
        "joined_rows": len(rows),
        "captures": {qid: {"path": CAPTURES[qid], "wire_sha256": cap.get("wire_sha256"),
                           "n": cap.get("n"), "model": cap.get("model"),
                           "questions_sha256": cap.get("questions_sha256")}
                     for qid, cap in captures.items()},
        "metrics_primary_context_proxy": {k: metrics(primary, k) for k in keys},
        "metrics_primary_independent_heldout": {k: metrics(independent, k) for k in keys},
        "metrics_prefix_proxy_nonprimary_diagnostic": {k: metrics(prefix, k) for k in keys},
        "subsets": {
            "primary_scored_n": len(primary),
            "primary_independent_heldout_n": len(independent),
            "prefix_scored_n": len(prefix),
            "full_denominator": 24,
            "quarantined_never_called": sorted({cid for cap in captures.values()
                                                for cid in cap.get("skipped_quarantined_ids", [])}),
        },
        "scope_assertions": {
            "exact_frozen_id_and_hash_join": True,
            "n": {"primary": len(primary), "independent": len(independent), "prefix": len(prefix)},
            "expected_n": {"primary": len(exp_primary), "independent": len(exp_independent), "prefix": len(exp_prefix)},
            "scope_id_sha256": {
                "primary": scope_digest(exp_primary),
                "independent": scope_digest(exp_independent),
                "prefix": scope_digest(exp_prefix),
            },
            "same_context_labels_as_frozen_scope": True,
        },
        "claims": {
            "no_gold_claim": True,
            "bounded_context_not_complete_history": True,
            "no_noul_choice_probability_equivalence": True,
            "ambiguous_rows_not_scored_as_accuracy": True,
            "exposure_provisional_rows_excluded_from_primary_independent_claims": True,
        },
    }
    replays = {}
    for qid, name in REPLAYS.items():
        path = os.path.join(HERE, name)
        if os.path.exists(path):
            rep = load(path)
            cap = captures[qid]
            same = all(
                (a.get("answers") == b.get("answers"))
                for a, b in zip(sorted(cap["results"], key=lambda x: x["id"]),
                                sorted(rep["results"], key=lambda x: x["id"]))
            )
            replays[qid] = {"present": True, "answers_identical": same,
                            "replayed_cases": rep.get("spend", {}).get("replayed_cases")}
        else:
            replays[qid] = {"present": False}
    report["replay_comparison"] = replays
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report["metrics_primary_context_proxy"], indent=2))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
