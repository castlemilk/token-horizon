#!/usr/bin/env python3
"""conditions.py SESSION_DIR — one row per arm: wall window, CPU idle mean/min + load1 (top.log),
thermal pressure levels (thermal.log / per-request thermal_start, if recorded), other-GPU ms/s before
(quiet.jsonl) and during (contention.jsonl) the arm, the Docker VM's mean CPU, and a GPU-speed proxy:
long-prompt prefill throughput (th: prompt tokens / client TTFT over ctx1500+ctxcold; Splash:
/status prefill_input_tokens / prefill_wall_ms over ctxcold, i.e. uncached rows only)."""
import collections, datetime, json, os, re, statistics as st, sys

D = sys.argv[1]
recs = [json.loads(l) for l in open(os.path.join(D, "runs.jsonl")) if l.strip()]
by_arm = collections.OrderedDict()
for r in sorted(recs, key=lambda r: r["wall_start"]):
    by_arm.setdefault(r["arm"], []).append(r)

tops = []; cur = None
for line in open(os.path.join(D, "top.log"), errors="replace"):
    m = re.match(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})", line)
    if m:
        if cur:
            tops.append(cur)
        cur = {"t": datetime.datetime.strptime(m.group(1), "%Y/%m/%d %H:%M:%S").timestamp(), "idle": None, "load": None, "vm": 0.0}
        continue
    if cur is None:
        continue
    m = re.search(r"CPU usage: .* ([\d.]+)% idle", line)
    if m:
        cur["idle"] = float(m.group(1)); continue
    m = re.search(r"Load Avg: ([\d.]+),", line)
    if m:
        cur["load"] = float(m.group(1)); continue
    m = re.match(r"^\s*(\d+)\s+(com\.apple\.Virtua)\S*\s+([\d.]+)", line)
    if m and m.group(1) == "71332":
        cur["vm"] += float(m.group(3))
if cur:
    tops.append(cur)
tops = tops[1:]
therm = []
tp = os.path.join(D, "thermal.log")
if os.path.exists(tp):
    for line in open(tp):
        p = line.split()
        if len(p) == 2 and p[1].isdigit():
            therm.append((float(p[0]), int(p[1])))
freq = []
fp = os.path.join(D, "gpufreq.jsonl")
MHZ = [338, 486, 636, 796, 888, 988, 1084, 1182, 1278, 1374, 1470, 1578, 1620]
if os.path.exists(fp):
    for line in open(fp):
        try:
            d = json.loads(line)
        except Exception:
            continue
        hh, mm, ss = (int(x) for x in d["t"].split(":"))
        base = datetime.datetime.fromtimestamp(recs[0]["wall_start"]).replace(hour=hh, minute=mm, second=ss, microsecond=0).timestamp()
        freq.append((base, d))
quiet = {}; cont = {}
for l in open(os.path.join(D, "quiet.jsonl")):
    d = json.loads(l)
    if "gpu" in d:
        quiet[d["arm"]] = d["gpu"]["other_gpu_ms_per_s"]
for l in open(os.path.join(D, "contention.jsonl")):
    d = json.loads(l)
    cont[d["arm"]] = d["contention"]["other_gpu_ms_per_s"]

ts = lambda x: datetime.datetime.fromtimestamp(x).strftime("%H:%M:%S")
print("| arm | engine | window | CPU idle % mean / min | load1 mean | thermal pressure (samples: level→count) | other-GPU ms/s pre / during | Docker VM %CPU | GPU active % / active-weighted MHz / P13 share of active | long-prompt prefill tok/s (GPU-speed proxy) |")
print("|---|---|---|---|---|---|---|---|---|---|")
for arm, rs in by_arm.items():
    t0 = rs[0]["wall_start"]; t1 = rs[-1]["wall_start"] + rs[-1]["total_ms"] / 1000
    w = [s for s in tops if t0 <= s["t"] <= t1 and s["idle"] is not None]
    idle = [s["idle"] for s in w]; load = [s["load"] for s in w if s["load"] is not None]; vm = [s["vm"] for s in w]
    th = [lv for t, lv in therm if t0 <= t <= t1]
    if not th:
        th = [r["thermal_start"] for r in rs if r.get("thermal_start") is not None]
    thd = dict(sorted(collections.Counter(th).items())) if th else "not recorded"
    fw = [d for t, d in freq if t0 <= t <= t1]
    if fw:
        act = st.mean(d["active_pct"] for d in fw)
        tot = collections.Counter()
        for d in fw:
            for k, v in d["residency_pct"].items():
                if k.startswith("P"):
                    tot[k] += v
        a = sum(tot.values())
        mhz = sum(MHZ[int(k[1:]) - 1] * v for k, v in tot.items() if 0 < int(k[1:]) <= len(MHZ)) / a if a else 0
        fs = f"{act:.0f}% / {mhz:.0f} / {100 * tot.get('P13', 0) / a if a else 0:.0f}%"
    else:
        fs = "not recorded"
    if rs[0]["engine_name"] == "splash":
        c = [r for r in rs if r["mode"] == "ctxcold" and r.get("status_delta")]
        pf = [r["status_delta"]["metrics.prefill_input_tokens"] / r["status_delta"]["metrics.prefill_wall_ms"] * 1000 for r in c]
        pfs = f"{st.mean(pf):.0f} (Splash /status, ctxcold, n={len(pf)})" if pf else "—"
    else:
        c = [r for r in rs if r["mode"] in ("ctx1500", "ctxcold") and r["ok"]]
        pf = [r["prompt_tokens"] / r["ttft_ms"] * 1000 for r in c]
        pfs = f"{st.mean(pf):.0f} (p_tok/TTFT, n={len(pf)})" if pf else "—"
    print(f"| {arm} | {rs[0]['engine_name']} | {ts(t0)}–{ts(t1)} | {st.mean(idle):.1f} / {min(idle):.1f} | {st.mean(load):.2f} | {thd} | "
          f"{quiet.get(arm, float('nan')):.1f} / {cont.get(arm, float('nan')):.1f} | {st.mean(vm):.0f} | {fs} | {pfs} |")
