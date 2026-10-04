#!/usr/bin/env python3
"""Score a case set with the live `work` question and report per-case outcomes.

Usage: score-rubric.py --questions <json> --cases <jsonl> --out <json>
Cases: {id, user_request, assistant_final, label?} — label is authorized_unfinished|finished|waiting|unclear.
The request/final are truncated exactly like the hook ([:900]/[:1200]) so a score matches runtime input.
"""
import argparse
import json
import os
import subprocess
import sys
import time

JEV_REPO = os.path.expanduser("~/repos/0x4007/jev-sandbox")

RUNNER = """
import json, sys, time
from jev_sandbox import route
route.apply()
from jev_sandbox import experiment
payload = json.loads(sys.stdin.read())
questions = payload["questions"]
out = []
for case in payload["cases"]:
    t = time.time()
    exp = experiment.run_json(
        {"user_request": case["user_request"][:900], "assistant_final": case["assistant_final"][:1200]},
        questions,
    )
    try:
        a = exp.choices["work"]
    except Exception:
        a = exp.nouls["work"]
    out.append({
        "id": case["id"],
        "choice": getattr(a, "choice", None),
        "confidence": getattr(a, "confidence", None),
        "probabilities": getattr(a, "probabilities", None),
        "replayed": bool((exp.cache or {}).get("replayed")),
        "ms": round((time.time() - t) * 1000),
    })
print(json.dumps(out))
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", required=True)
    ap.add_argument("--cases", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    questions = json.load(open(args.questions))
    cases = [json.loads(l) for l in open(args.cases) if l.strip()]
    print(f"scoring {len(cases)} cases with {args.questions}", file=sys.stderr)

    proc = subprocess.run(
        ["uv", "run", "python", "-c", RUNNER],
        cwd=JEV_REPO,
        input=json.dumps({"questions": questions, "cases": cases}),
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if proc.returncode != 0:
        print(proc.stderr[-2000:], file=sys.stderr)
        return 1
    results = json.loads(proc.stdout.strip().splitlines()[-1])
    by_id = {r["id"]: r for r in results}

    ok = bad = nolabel = 0
    for case in cases:
        r = by_id[case["id"]]
        p = (r["probabilities"] or {}).get("authorized_unfinished")
        label = case.get("label")
        verdict = ""
        if label:
            hit = r["choice"] == label
            verdict = "ok" if hit else f"MISMATCH (want {label})"
            ok += hit
            bad += not hit
        else:
            nolabel += 1
        print(f"  {case['id']:<26} {r['choice']:<22} p_au={p if p is None else round(p, 2):<5} {verdict}")

    report = {"questions": args.questions, "n": len(cases), "ok": ok, "mismatch": bad, "nolabel": nolabel,
              "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": results,
              "cases": {c["id"]: {"label": c.get("label"), "user_request": c["user_request"], "assistant_final": c["assistant_final"]} for c in cases}}
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=2)
    print(f"{ok}/{ok + bad} labelled cases correct; wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
