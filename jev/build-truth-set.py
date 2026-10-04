#!/usr/bin/env python3
"""Extract a defensible ground-truth set directly from turn structure.

Positive (real stop): the turn completed, its last item is an assistant text
message, and the turn contains NO tool call anywhere. A turn that ends with an
announcement and performed no tool work is the mechanical signature of the
reported defect: the model narrated intent and the turn closed before acting.

Negative (real completion): the turn completed and contains at least one tool
call, so work was actually performed, plus the turn's final text is a report.
"""
import json, os, sqlite3, sys

CODEX = os.path.expanduser("~/.codex")
HISTORY = os.path.join(CODEX, "thread_history_1.sqlite")
OUT = os.path.join(os.path.dirname(__file__), "truth.jsonl")

def main() -> int:
    con = sqlite3.connect(f"file:{HISTORY}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("SELECT thread_id, turn_id FROM thread_turns WHERE status='completed' ORDER BY thread_id, rollout_ordinal")
    turns = cur.fetchall()
    by_thread = {}
    for tid, turn in turns:
        by_thread.setdefault(tid, []).append(turn)

    rows = []
    for thread_id, turn_ids in by_thread.items():
        ph = ",".join("?" * len(turn_ids))
        cur.execute(f"SELECT turn_id, item_json FROM thread_items WHERE thread_id=? AND turn_id IN ({ph}) ORDER BY rollout_ordinal",
                    [thread_id, *turn_ids])
        per = {t: [] for t in turn_ids}
        for turn_id, item_json in cur.fetchall():
            try: item = json.loads(item_json)
            except Exception: continue
            per[turn_id].append(item)

        for turn_id in turn_ids:
            items = per[turn_id]
            if len(items) < 2: continue
            types = [i.get("type") for i in items]
            users = [i for i in items if i.get("type") == "userMessage"]
            agents = [i for i in items if i.get("type") == "agentMessage"]
            if not users or not agents: continue
            request = " ".join(c.get("text", "") for c in (users[0].get("content") or []) if isinstance(c, dict)).strip()
            if len(request) < 40: continue
            final = (agents[-1].get("text") or "").strip()
            if len(final) < 40: continue
            if types[-1] != "agentMessage": continue     # must end on assistant text

            worked = any(t in ("functionCall", "customToolCall", "localShellCall", "webSearch") for t in types)
            # Mechanical positive: no tool call at all in the turn.
            label = "done" if worked else "stop"
            rows.append({
                "thread_id": thread_id, "turn_id": turn_id, "label": label,
                "n_items": len(items),
                "user_request": request[:1500], "assistant_final": final[:1500],
            })

    with open(OUT, "w") as fh:
        for r in rows: fh.write(json.dumps(r) + "\n")
    s = sum(1 for r in rows if r["label"] == "stop")
    print(f"wrote {len(rows)} -> {OUT}  stop={s} done={len(rows)-s}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
