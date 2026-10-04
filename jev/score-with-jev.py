#!/usr/bin/env python3
"""Score the labelled corpus with Jev and report precision/recall.

Usage: score-with-jev.py [--limit N] [--threshold T] [--positivenudge-only]
Reads jev/corpus.jsonl, writes jev/score.json and prints a confusion matrix.
"""
import argparse
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "corpus.jsonl")
REPO = os.path.expanduser("~/repos/0x4007/jev-sandbox")

QUESTION = {
    "unfinished": {
        "type": "noul",
        "instructions": {
            "question": "Did the assistant leave requested work unfinished in assistant_final?",
            "inspect": "user_request and assistant_final",
            "focus": "Judge only whether work the user asked for remains undone. Ignore style, tone and quality.",
        },
        "criteria": {
            "true": {
                "what": "The user asked for specific work, and the final message shows it was not performed, or was deferred to a later step that never happened",
                "examples": ["Let me read the last file next.", "I will now apply the fix."],
            },
            "false": {
                "what": "The requested work was performed, or the assistant is legitimately finished, blocked, or asking for input",
                "not_for": "A finished answer, an explicit blocker, or a request for clarification",
                "examples": ["All three files read. Summary: ...", "Tests pass; the fix is complete."],
            },
        },
    }
}


def score_batch(cases):
    """Run one Jev call per case in a single subprocess; return probabilities."""
    payload = json.dumps(cases)
    script = f"""
import json, sys, time
from jev_sandbox import route
route.apply()
from jev_sandbox.client import build_client
c = build_client()
cases = json.loads(sys.stdin.read())
Q = json.loads({json.dumps(json.dumps(QUESTION))})
out = []
for case in cases:
    state = {{"user_request": case["user_request"], "assistant_final": case["assistant_final"]}}
    t = time.time()
    r = c.system_one(state=state, questions=Q)
    out.append({{"id": case["id"], "p": r.nouls["unfinished"].noul, "ms": round((time.time()-t)*1000)}})
print(json.dumps(out))
"""
    proc = subprocess.run(
        ["uv", "run", "python", "-c", script],
        cwd=REPO, input=payload, capture_output=True, text=True, timeout=1800,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr[-2000:])
    return json.loads(proc.stdout.strip().splitlines()[-1])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=260)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(CORPUS)]
    stops = [r for r in rows if r["label"] == "stop"]
    done = [r for r in rows if r["label"] == "done"]
    random.seed(args.seed)
    done_sample = random.sample(done, min(len(done), args.limit - len(stops)))
    sample = stops + done_sample
    for i, row in enumerate(sample):
        row["id"] = i

    print(f"scoring {len(sample)} turns ({len(stops)} stop / {len(done_sample)} done)")
    results = score_batch([
        {"id": r["id"], "user_request": r["user_request"], "assistant_final": r["assistant_final"]}
        for r in sample
    ])
    probs = {r["id"]: r["p"] for r in results}
    lat = [r["ms"] for r in results]

    tp = fp = fn = tn = 0
    for row in sample:
        p = probs[row["id"]]
        fired = p >= args.threshold
        if row["label"] == "stop" and fired:
            tp += 1
        elif row["label"] == "stop":
            fn += 1
        elif fired:
            fp += 1
        else:
            tn += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    report = {
        "threshold": args.threshold, "n": len(sample), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": round(precision, 4), "recall": round(recall, 4),
        "latency_ms_p50": sorted(lat)[len(lat)//2], "latency_ms_max": max(lat),
        "scores": {str(r["id"]): r["p"] for r in results},
    }
    print(json.dumps({k: v for k, v in report.items() if k != "scores"}, indent=2))
    with open(os.path.join(HERE, "score.json"), "w") as fh:
        json.dump(report, fh, indent=2)

    print("\n--- highest-scoring negatives (false positives) ---")
    fps = sorted([r for r in sample if r["label"] == "done" and probs[r["id"]] >= args.threshold],
                 key=lambda r: -probs[r["id"]])[:8]
    for r in fps:
        print(f"  p={probs[r['id']]:.2f} next={r['next_user_message'][:50]!r} fin={r['assistant_final'][:90]!r}")
    print("\n--- lowest-scoring positives (misses) ---")
    fns = sorted([r for r in sample if r["label"] == "stop" and probs[r["id"]] < args.threshold],
                 key=lambda r: probs[r["id"]])[:8]
    for r in fns:
        print(f"  p={probs[r['id']]:.2f} next={r['next_user_message'][:50]!r} fin={r['assistant_final'][:90]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
