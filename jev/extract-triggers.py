#!/usr/bin/env python3
"""Extract every trigger instance across history.

A trigger is one of:
  - the owner setting a goal (a directive to set/create a goal, or /goal usage)
  - a bare acknowledgement/continuation: ok, okay, k, proceed, continue, go on, go ahead

For each, capture the preceding turn's opening user request and its final
assistant message. The owner reports that most of these mark failed turns:
the assistant stopped before doing what it announced.
"""
import datetime
import json
import os
import re
import sqlite3
import sys

CODEX = os.path.expanduser("~/.codex")
HISTORY = os.path.join(CODEX, "thread_history_1.sqlite")
OUT = os.path.join(os.path.dirname(__file__), "triggers.jsonl")

GOALKW = re.compile(r"(set (a |the )?new goal|set a goal|set the goal|create a goal|new goal|/goal)", re.I)
SHORT = re.compile(r"^\s*(ok|okay|k|proceed|continue|go on|go ahead)\s*[.!]?\s*$", re.I)

def text_of(item):
    if item.get("type") != "userMessage":
        return None
    return " ".join(c.get("text", "") for c in (item.get("content") or []) if isinstance(c, dict)).strip()

def main() -> int:
    con = sqlite3.connect(f"file:{HISTORY}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("SELECT thread_id, turn_id, status, started_at FROM thread_turns WHERE status IN ('completed','interrupted') ORDER BY thread_id, rollout_ordinal")
    turns = cur.fetchall()
    by_thread: dict[str, list] = {}
    for tid, turn, status, ts in turns:
        by_thread.setdefault(tid, []).append((turn, status, ts))

    rows = []
    for thread_id, seq in by_thread.items():
        tids = [t for t, _, _ in seq]
        ph = ",".join("?" * len(tids))
        cur.execute(
            f"SELECT turn_id, item_json FROM thread_items WHERE thread_id=? AND turn_id IN ({ph}) ORDER BY rollout_ordinal",
            [thread_id, *tids],
        )
        per: dict[str, list] = {t: [] for t in tids}
        for turn_id, item_json in cur.fetchall():
            try:
                per[turn_id].append(json.loads(item_json))
            except Exception:
                continue
        for i, (turn_id, status, ts) in enumerate(seq):
            items = per[turn_id]
            first = next((text_of(x) for x in items if text_of(x)), None)
            if not first:
                continue
            is_goal = bool(GOALKW.search(first)) and len(first) < 120
            if not (is_goal or SHORT.match(first)):
                continue
            prev_final = prev_req = None
            if i > 0:
                pitems = per[seq[i - 1][0]]
                agents = [x for x in pitems if x.get("type") == "agentMessage"]
                if agents:
                    prev_final = (agents[-1].get("text") or "").strip()
                pu = [text_of(x) for x in pitems if text_of(x)]
                if pu:
                    prev_req = pu[0]
            if not prev_final or len(prev_final) < 20:
                continue
            rows.append({
                "thread_id": thread_id,
                "turn_id": seq[i - 1][0],
                "trigger_turn": turn_id,
                "trigger_kind": "goal" if is_goal else "ack",
                "trigger_text": first[:120],
                "status": status,
                "ts": ts,
                "user_request": (prev_req or "")[:1500],
                "assistant_final": prev_final[:1500],
            })

    with open(OUT, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    goals = sum(1 for r in rows if r["trigger_kind"] == "goal")
    print(f"wrote {len(rows)} trigger instances -> {OUT}  (goal={goals} ack={len(rows)-goals})")
    return 0

if __name__ == "__main__":
    sys.exit(main())
