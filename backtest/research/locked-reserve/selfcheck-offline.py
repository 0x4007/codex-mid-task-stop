#!/usr/bin/env python3
"""Offline checks for locked-reserve-eval-v1: synthetic composition folding plus the
actual 22-case payload/CLI regression with a mocked subprocess (no provider)."""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_PRIVATE_INPUTS = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".publication-audit", "research-goal", "locked-reserve-eval-v1"))
HERE = _PRIVATE_INPUTS if os.path.isdir(_PRIVATE_INPUTS) else _HERE
spec = importlib.util.spec_from_file_location("compose_locked_reserve", os.path.join(HERE, "compose-locked-reserve.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

rows = [
    {"label": "authorized_unfinished", "v3_0.5": True, "v3_0.6": True, "explicit_0.8": False,
     "work_0.56": True, "composition_v3_ge_0.5_or_explicit_ge_0.8": True,
     "composition_v3_ge_0.6_or_explicit_ge_0.8": True},
    {"label": "finished", "v3_0.5": False, "v3_0.6": False, "explicit_0.8": True,
     "work_0.56": False, "composition_v3_ge_0.5_or_explicit_ge_0.8": True,
     "composition_v3_ge_0.6_or_explicit_ge_0.8": True},
    {"label": "waiting", "v3_0.5": False, "v3_0.6": False, "explicit_0.8": False,
     "work_0.56": False, "composition_v3_ge_0.5_or_explicit_ge_0.8": False,
     "composition_v3_ge_0.6_or_explicit_ge_0.8": False},
]
m = mod.metrics(rows, "composition_v3_ge_0.5_or_explicit_ge_0.8")
assert m == {"n": 3, "tp": 1, "fp": 1, "fn": 0, "tn": 1, "accuracy": 0.666667,
             "positive_n": 1, "waiting_n": 1, "waiting_false_resume": 0,
             "waiting_false_resume_rate": 0.0}, m
assert mod.decision_noul({"decision": {"kind": "noul", "decisions": {"0.5": True}}}, 0.5) is True
assert mod.decision_choice({"decision": {"kind": "choice", "resume_runtime": True}}) is True

# actual frozen 22-case payload + real CLI/normalizer path, subprocess mocked
rspec = importlib.util.spec_from_file_location("locked_reserve_runner", os.path.join(HERE, "runner-present-tense-v3.py"))
runner = importlib.util.module_from_spec(rspec)
rspec.loader.exec_module(runner)
cfg = runner.load_json(runner.CONFIG_PATH)
cases = runner.load_rows(os.path.join(HERE, cfg["cases_file"]))
allowed = [c for c in cases if c["provider_call_allowed"]]
assert len(cases) == 24 and len(allowed) == 22, (len(cases), len(allowed))
expected_ids = [c["case_id"] for c in allowed]
captured = {}
real_run = runner.subprocess.run


def fake_run(argv, **kwargs):
    payload = json.loads(kwargs["input"])
    captured["argv"] = argv
    captured["payload"] = payload
    out = [{"id": case["id"],
            "answers": {cfg["qid"]: {"kind": "noul", "p": 0.42}},
            "extra": {"cache": {"replayed": False}, "input_tokens": 123, "output_tokens": 7,
                      "model": "typesafe/jev-1.13-20260917",
                      "response_model": "typesafe/jev-1.13-20260917"},
            "replayed": False, "ms": 1} for case in payload["cases"]]
    return types.SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(
        {"wire_sha256": cfg["wire_sha256_expected"], "results": out}) + "\n")


runner.subprocess.run = fake_run
try:
    tmp = tempfile.mkdtemp(prefix="locked-reserve-selfcheck-")
except Exception:
    tmp = os.path.join(HERE, ".selfcheck-tmp")
    os.makedirs(tmp, exist_ok=True)
tmp_out = os.path.join(tmp, "report.json")
old_argv = sys.argv
try:
    sys.argv = ["runner-present-tense-v3.py", "--out", tmp_out]
    rc = runner.main()
finally:
    runner.subprocess.run = real_run
    sys.argv = old_argv
assert rc == 0, rc
assert [c.get("id") for c in captured["payload"]["cases"]] == expected_ids
assert all("case_id" not in c for c in captured["payload"]["cases"])
report = runner.load_json(tmp_out)
assert report["n"] == 22 and [r["id"] for r in report["results"]] == expected_ids
for r in report["results"]:
    d = r["decision"]
    assert d["kind"] == "noul" and "0.5" in d["decisions"] and "0.6" in d["decisions"]
    assert r["prefix_pair_sha256"] and r["state_window_sha256"] and r["input_row_sha256"]
shutil.rmtree(tmp, ignore_errors=True)

# downstream composition/metric functions accept the normalized actual rows
caps = {}
for qid in ("present_tense_v3", "work", "explicit_remaining"):
    results = []
    for r in report["results"]:
        base = dict(r)
        if qid == "work":
            pred = bool(r["decision"]["decisions"]["0.5"])
            base["decision"] = {"kind": "choice", "resume_runtime": pred,
                                "p_authorized_unfinished": 0.9 if pred else 0.1}
        elif qid == "explicit_remaining":
            base["decision"] = {"kind": "noul", "decisions": {"0.8": bool(r["decision"]["decisions"]["0.6"])}}
        results.append(base)
    caps[qid] = {"results": results}
joined = mod.build_rows(caps)
assert len(joined) == 22, len(joined)
primary = [r for r in joined if r["label"] is not None and r["provider_call_allowed"]]
mm = mod.metrics(primary, "v3_0.5")
assert mm["n"] == 15, mm  # structural count from the frozen proxies; synthetic answers, not a real metric
print("selfcheck-ok (synthetic-compose + actual-case-payload-cli)")
sys.exit(0)
