#!/usr/bin/env python3
"""Emit a human-adjudicable review set from the scored corpus.

Selects the turns where the machine labels and Jev disagree most, plus a sample
of agreements, so the owner can adjudicate in one pass. Writes Markdown.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(os.path.join(HERE, "corpus.jsonl"))]
score = json.load(open(os.path.join(HERE, "score.json")))["scores"]

by_id = {}
for i, r in enumerate(rows):
    r["id"] = i
    by_id[i] = r

scored = [(int(k), v) for k, v in score.items()]

# Disagreements first: Jev says unfinished (>=0.5) but label says done, and vice versa.
fp = [(i, p) for i, p in scored if p >= 0.5 and by_id[i]["label"] == "done"]
fn = [(i, p) for i, p in scored if p < 0.5 and by_id[i]["label"] == "stop"]
tp = [(i, p) for i, p in scored if p >= 0.5 and by_id[i]["label"] == "stop"]
tn = [(i, p) for i, p in scored if p < 0.5 and by_id[i]["label"] == "done"]

fp.sort(key=lambda x: -x[1]); fn.sort(key=lambda x: x[1])

def block(title, items, limit):
    out = [f"## {title} ({len(items)} total, showing {min(limit,len(items))})", ""]
    for i, p in items[:limit]:
        r = by_id[i]
        req = r["user_request"][:400].replace("\n", " ")
        fin = r["assistant_final"][:700].replace("\n", " ")
        out += [
            f"### id {i} — Jev P(unfinished)={p:.2f} — machine label: {r['label']}",
            "",
            f"- **User request:** {req}",
            f"- **Assistant final message:** {fin}",
            f"- **Owner replied next:** `{r['next_user_message']}`",
            "- **Your verdict:** ( ) stopped early  ( ) genuinely done  ( ) blocked / needed input",
            "",
        ]
    return out

lines = [
    "# Adjudication set: does Jev detect premature stops?",
    "",
    "Instructions: for each turn, read the user request and the assistant's final message.",
    "Mark whether the assistant **stopped early** (work remained) or was **genuinely done**.",
    "Ignore the machine label and Jev's number — they are what we are testing.",
    "",
    "A ground truth from you is the only thing that can turn this into a real measurement.",
    "",
]
lines += block("Disagreement A — Jev says UNFINISHED, machine label says done", fp, 40)
lines += block("Disagreement B — Jev says FINISHED, machine label says stop", fn, 40)
lines += block("Agreement check — Jev says UNFINISHED, label says stop (spot check)", tp, 10)
lines += block("Agreement control — Jev says FINISHED, label says done (spot check)", tn, 10)

path = os.path.join(HERE, "review-set.md")
with open(path, "w") as fh:
    fh.write("\n".join(lines))
print(f"wrote {path}: {len(fp)} fp, {len(fn)} fn, {len(tp)} tp, {len(tn)} tn candidates")
