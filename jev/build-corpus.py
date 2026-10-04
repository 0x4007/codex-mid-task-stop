#!/usr/bin/env python3
"""Build a labelled turn corpus from the live Codex stores.

Positive = a turn that ended text-only and that the owner immediately nudged with
an unambiguous continuation instruction (`proceed`). Negatives = turns that ended
text-only and were followed by a new substantive request, i.e. the owner moved on,
which means the turn was not a premature stop.

Read-only against ~/.codex. Writes only into this repository.
"""
import json
import os
import re
import sqlite3
import sys

CODEX = os.path.expanduser("~/.codex")
HISTORY = os.path.join(CODEX, "thread_history_1.sqlite")
OUT = os.path.join(os.path.dirname(__file__), "corpus.jsonl")

# Unambiguous continuation nudges. `ok` is deliberately excluded: it is ambiguous
# between acknowledgement and nudge and it inverted an earlier measurement.
NUDGE = re.compile(r"^\s*(proceed|continue|go on|keep going|go ahead)\b[.!]?\s*$", re.I)

def text_of(item_json: str) -> tuple[str, str]:
    try:
        item = json.loads(item_json)
    except Exception:
        return "", ""
    kind = item.get("type", "")
    if kind == "userMessage":
        parts = [c.get("text", "") for c in (item.get("content") or []) if isinstance(c, dict)]
        return "user", " ".join(p for p in parts if p).strip()
    if kind == "agentMessage":
        return "agent", (item.get("text") or "").strip()
    return "", ""

def main() -> int:
    con = sqlite3.connect(f"file:{HISTORY}?mode=ro", uri=True)
    cur = con.cursor()
    # Only normally-completed turns: interrupted and failed are the owner's own
    # mis-clicks and hard errors, and they must never be counted as model stops.
    cur.execute(
        """
        SELECT t.thread_id, t.turn_id, t.status
        FROM thread_turns t
        WHERE t.status = 'completed'
        ORDER BY t.thread_id, t.rollout_ordinal
        """
    )
    turns = cur.fetchall()

    by_thread: dict[str, list[tuple[str, str]]] = {}
    for thread_id, turn_id, status in turns:
        by_thread.setdefault(thread_id, []).append((turn_id, status))

    rows = []
    for thread_id, seq in by_thread.items():
        placeholders = ",".join("?" * len(seq))
        tids = [t for t, _ in seq]
        cur.execute(
            f"""
            SELECT turn_id, item_json FROM thread_items
            WHERE thread_id = ? AND turn_id IN ({placeholders})
            ORDER BY rollout_ordinal
            """,
            [thread_id, *tids],
        )
        per_turn: dict[str, list[tuple[str, str]]] = {t: [] for t in tids}
        for turn_id, item_json in cur.fetchall():
            role, text = text_of(item_json)
            if role and text:
                per_turn[turn_id].append((role, text))

        for i, turn_id in enumerate(tids):
            items = per_turn[turn_id]
            if not items:
                continue
            last_role, last_text = items[-1]
            if last_role != "agent":
                continue  # not a text-only ending
            if len(items) < 2 or items[-2][0] != "user":
                pass
            # the user request that opened this turn
            request = next((t for r, t in items if r == "user"), "")
            if not request or len(request) < 20:
                continue
            # the next user message after this turn
            nxt = None
            for j in range(i + 1, len(tids)):
                nxt = next((t for r, t in per_turn[tids[j]] if r == "user"), None)
                if nxt:
                    break
            if nxt is None:
                continue
            label = "stop" if NUDGE.match(nxt) else "done"
            rows.append({
                "thread_id": thread_id,
                "turn_id": turn_id,
                "label": label,
                "next_user_message": nxt[:80],
                "user_request": request[:2000],
                "assistant_final": last_text[:2000],
            })

    with open(OUT, "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
    stops = sum(1 for r in rows if r["label"] == "stop")
    print(f"wrote {len(rows)} rows -> {OUT}")
    print(f"  stop={stops}  done={len(rows)-stops}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
