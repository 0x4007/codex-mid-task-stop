#!/usr/bin/env python3
"""Frozen locked-reserve single-question runner, profile explicit-remaining.

Adapted file-by-file from novel-runner.py (sha256 578000f02ddd2bb6a41ce53292265fd618c6f92ce676c250e779c5048a07aead) and
choice-runner.py (sha256 73ac7c2725b4b8309cbcab66f22bcd9c7ecc16e668dc46477087b5a42ee0a9e7): same SDK route.apply(), same
experiment.run_json protocol, same FIRST900 request / FIRST1200 final Unicode
code-point windows, same existing JEV_CACHE/paired-cache and OPENROUTER_API_KEY,
same model jev-1.13.0. The only CLI option is the original documented --out.

The runner sends only privacy-safe rows (any privacy_pass false in any of the
four completed blind reviews => no provider call for that case). It records the
SDK wire-form sha256 of the unchanged question, per-case answers/probabilities,
decisions, model echo, cache flags, token counters and cost assumptions. Metrics
are post-call reporting only; no question/threshold tuning happens here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_PRIVATE_INPUTS = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".publication-audit", "research-goal", "locked-reserve-eval-v1"))
RUNNER_DIR = _PRIVATE_INPUTS if os.path.isdir(_PRIVATE_INPUTS) else _HERE
CONFIG_PATH = os.path.join(RUNNER_DIR, "config-explicit-remaining.json")
JEV_REPO = ""  # resolved from the fixed JSON config (existing interface)

RUNNER = """
import json, sys, time, hashlib
from jev_sandbox import route
route.apply()
from jev_sandbox import experiment
from jev_sandbox import wire as jev_wire
payload = json.loads(sys.stdin.read())
questions = payload["questions"]
wire_form = jev_wire.questions_from_json(questions)
wire_list = [jev_wire.question_to_json(qid, q) for qid, q in wire_form.items()]
wire_sha = hashlib.sha256(json.dumps(wire_list, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
out = []
for case in payload["cases"]:
    t = time.time()
    exp = experiment.run_json(
        {"user_request": case["user_request"][:900], "assistant_final": case["assistant_final"][:1200]},
        questions,
    )
    answers = {}
    for qid, a in exp.answers.items():
        if hasattr(a, "noul"):
            answers[qid] = {"kind": "noul", "p": float(a.noul)}
        elif hasattr(a, "choice"):
            probs = getattr(a, "probabilities", None)
            if probs is not None and not isinstance(probs, dict):
                try:
                    probs = dict(probs)
                except Exception:
                    probs = None
            answers[qid] = {"kind": "choice", "choice": a.choice, "confidence": getattr(a, "confidence", None),
                            "probabilities": probs}
    extra = {"cache": getattr(exp, "cache", None)}
    for attr in ("input_tokens", "output_tokens", "request_id", "model"):
        try:
            extra[attr] = getattr(exp, attr)
        except Exception:
            extra[attr] = None
    resp = getattr(exp, "response", None)
    extra["response_model"] = getattr(resp, "model", None) if resp is not None else None
    out.append({"id": case["id"], "answers": answers, "extra": extra,
                "replayed": bool((getattr(exp, "cache", None) or {}).get("replayed")),
                "ms": round((time.time() - t) * 1000)})
print(json.dumps({"wire_sha256": wire_sha, "results": out}))
"""


def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_rows(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def canonical_pair_sha256(u, f):
    return hashlib.sha256(json.dumps({"user_request": u, "assistant_final": f}, sort_keys=True,
                                     separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def state_window_sha256(u, f):
    return hashlib.sha256((u[:900] + "\u0000" + f[:1200]).encode("utf-8")).hexdigest()


def run_batch(questions, cases):
    payload = {"questions": questions,
               "cases": [{"id": c["case_id"], "user_request": c["user_request"], "assistant_final": c["assistant_final"]}
                         for c in cases]}
    proc = subprocess.run(["uv", "run", "python", "-c", RUNNER], cwd=JEV_REPO,
                          input=json.dumps(payload), capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-2000:])
        sys.exit(1)
    return json.loads(proc.stdout.strip().splitlines()[-1])


def decision_fields(qid, kind, answer, profile):
    out = {"qid": qid, "kind": kind}
    if kind == "noul":
        p = float(answer.get("p", 0.0))
        out["p"] = p
        out["decisions"] = {str(t): bool(p >= t) for t in profile["thresholds"]}
    elif kind == "choice":
        probs = answer.get("probabilities") or {}
        p_au = probs.get("authorized_unfinished")
        out["choice"] = answer.get("choice")
        out["confidence"] = answer.get("confidence")
        out["probabilities"] = probs
        out["p_authorized_unfinished"] = p_au
        out["probabilities_missing"] = p_au is None
        out["resume_gate_metric"] = answer.get("choice") == "authorized_unfinished"
        out["resume_runtime"] = bool(answer.get("choice") == "authorized_unfinished" and p_au is not None
                                     and p_au >= profile["floor"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    cfg = load_json(CONFIG_PATH)
    global JEV_REPO
    JEV_REPO = cfg["jev_repo"]
    profile = cfg["profile"]
    questions_path = os.path.normpath(os.path.join(RUNNER_DIR, cfg["questions_file"]))
    cases_path = os.path.normpath(os.path.join(RUNNER_DIR, cfg["cases_file"]))
    q_sha = sha256_file(questions_path)
    c_sha = sha256_file(cases_path)
    if q_sha != cfg["questions_sha256"]:
        print("questions hash mismatch", file=sys.stderr)
        return 2
    if c_sha != cfg["cases_sha256"]:
        print("cases hash mismatch", file=sys.stderr)
        return 2
    questions = load_json(questions_path)
    qid = cfg["qid"]
    if qid not in questions:
        print(f"qid {qid} absent", file=sys.stderr)
        return 2
    cases = load_rows(cases_path)
    if len(cases) != cfg["caps"]["cases"] or [c["case_id"] for c in cases] != cfg["frozen_case_ids"]:
        print("case set mismatch", file=sys.stderr)
        return 2
    allowed, skipped = [], []
    for c in cases:
        bad = c["privacy_quarantine"] or not c["provider_call_allowed"]
        (skipped if bad else allowed).append(c)
    if len(allowed) > cfg["caps"]["max_fresh_calls"]:
        print("fresh call cap exceeded", file=sys.stderr)
        return 2
    worst = len(allowed) * cfg["caps"]["forecast_input_tokens_per_case"] * cfg["caps"]["price_per_m_input_tokens"] / 1_000_000.0
    if worst > cfg["caps"]["cost_ceiling_usd"]:
        print(f"worst-case forecast ${worst:.6f} exceeds ceiling", file=sys.stderr)
        return 2
    for c in allowed + skipped:
        if canonical_pair_sha256(c["user_request"], c["assistant_final"]) != c["prefix_pair_sha256"]:
            print("state pair hash drift", file=sys.stderr)
            return 2
        if state_window_sha256(c["user_request"], c["assistant_final"]) != c["state_window_sha256"]:
            print("state window hash drift", file=sys.stderr)
            return 2
    t0 = time.time()
    batch = run_batch(questions, allowed)
    results = batch["results"]
    if [r["id"] for r in results] != [c["case_id"] for c in allowed]:
        print("result id/order mismatch", file=sys.stderr)
        return 2
    by_id = {c["case_id"]: c for c in cases}
    bought_in = bought_out = 0
    unknown_usage = False
    replayed_cases = 0
    model_echoes = set()
    for r in results:
        c = by_id[r["id"]]
        r["prefix_pair_sha256"] = c["prefix_pair_sha256"]
        r["state_window_sha256"] = c["state_window_sha256"]
        r["input_row_sha256"] = c["input_row_sha256"]
        r["primary_context_proxy_label"] = c["primary_context_proxy_label"]
        r["prefix_proxy_label"] = c["prefix_proxy_label"]
        r["provider_call_allowed"] = c["provider_call_allowed"]
        r["primary_independent_heldout"] = c.get("primary_independent_heldout")
        r["exposure_status"] = c.get("exposure_status")
        answer = (r.get("answers") or {}).get(qid) or {}
        r["decision"] = decision_fields(qid, cfg["kind"], answer, profile)
        echo = (r.get("extra") or {}).get("model") or (r.get("extra") or {}).get("response_model")
        if echo:
            model_echoes.add(str(echo))
        if r["replayed"]:
            replayed_cases += 1
            continue
        ti = (r.get("extra") or {}).get("input_tokens")
        to = (r.get("extra") or {}).get("output_tokens")
        if ti is None or to is None:
            unknown_usage = True
        else:
            bought_in += int(ti)
            bought_out += int(to)
    if unknown_usage:
        cost_usd, cost_status = None, "unknown"
    elif replayed_cases == len(results):
        cost_usd, cost_status = 0.0, "known"
    else:
        cost_usd = round(bought_in * cfg["caps"]["price_per_m_input_tokens"] / 1_000_000.0, 6)
        cost_status = "known"
    report = {
        "schema": "locked-reserve-results/v1",
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "profile": cfg["profile"],
        "runner": os.path.basename(__file__),
        "runner_sha256": sha256_file(os.path.abspath(__file__)),
        "config_sha256": sha256_file(CONFIG_PATH),
        "questions_file": cfg["questions_file"],
        "questions_sha256": q_sha,
        "qid": qid,
        "kind": cfg["kind"],
        "wire_sha256": batch["wire_sha256"],
        "wire_sha256_expected": cfg["wire_sha256_expected"],
        "wire_sha256_matches_expected": batch["wire_sha256"] == cfg["wire_sha256_expected"],
        "model": cfg["model"],
        "state_truncation": cfg["state"]["truncation"],
        "state_unit": cfg["state"]["unit"],
        "operating_points": profile["thresholds"] if cfg["kind"] == "noul" else [profile["floor"]],
        "n": len(results),
        "logical_requests": len(results),
        "skipped_quarantined_ids": [c["case_id"] for c in skipped],
        "full_denominator": len(cases),
        "model_echoes": sorted(model_echoes),
        "results": results,
        "spend": {
            "replayed_cases": replayed_cases,
            "misses": len(results) - replayed_cases,
            "bought_input_tokens": bought_in,
            "bought_output_tokens": bought_out,
            "cost_usd": cost_usd,
            "cost_status": cost_status,
            "price_per_m_input_tokens": cfg["caps"]["price_per_m_input_tokens"],
            "accounting_caveats": [
                "cost prices input tokens only; output tokens are not priced by this runner",
                "0.042 USD/M is the frozen config assumption, not a provider receipt",
                "replayed cases report $0 as cache accounting, not proof of free provider compute",
                "replayed is the SDK cache self-report; fresh provider determinism is not claimed",
            ],
        },
        "claims": {
            "no_paid_calls_at_prepare_time": True,
            "no_question_threshold_or_model_tuning": True,
            "no_noul_choice_probability_equivalence": True,
            "same_model_consensus_is_not_truth": True,
            "bounded_context_not_complete_history": True,
            "exposure_provisional_rows_excluded_from_primary_independent_claims": True,
        },
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps({"profile": cfg["profile"], "wire_sha256": batch["wire_sha256"],
                      "n": len(results), "skipped": len(skipped), "spend": report["spend"]}, indent=2))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
