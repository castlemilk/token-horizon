#!/usr/bin/env python3
"""cpuctx.py SESSION_DIR — CPU contention during each arm / mode, from the background
`top -l 0 -s 3` sampler (top.log) joined to runs.jsonl request windows.
Reports per arm: mean/min CPU idle %, mean load1, and the top non-engine CPU users
(engine = th-engine / splash processes, which are the system under test)."""
import collections, datetime, json, os, re, statistics as st, sys

D = sys.argv[1]
recs = [json.loads(l) for l in open(os.path.join(D, "runs.jsonl")) if l.strip()]
samples = []  # (epoch, idle, load1, [(pid, cmd, cpu)])
cur = None
RE_T = re.compile(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})")
RE_CPU = re.compile(r"CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle")
RE_LOAD = re.compile(r"Load Avg: ([\d.]+),")
RE_P = re.compile(r"^(\d+)\s+(.+?)\s+([\d.]+)\s*$")
first_sample_seen = False
for line in open(os.path.join(D, "top.log"), errors="replace"):
    line = line.rstrip("\n")
    m = RE_T.match(line)
    if m:
        if cur:
            samples.append(cur)
        t = datetime.datetime.strptime(m.group(1), "%Y/%m/%d %H:%M:%S").timestamp()
        cur = {"t": t, "idle": None, "load1": None, "procs": []}
        continue
    if cur is None:
        continue
    m = RE_CPU.search(line)
    if m:
        cur["idle"] = float(m.group(3)); continue
    m = RE_LOAD.search(line)
    if m:
        cur["load1"] = float(m.group(1)); continue
    m = RE_P.match(line.strip())
    if m and cur["idle"] is not None:
        cur["procs"].append((int(m.group(1)), m.group(2).strip(), float(m.group(3))))
if cur:
    samples.append(cur)
# top's first sample has no valid CPU delta (cumulative since boot) -> drop it
samples = samples[1:]
ENGINE = re.compile(r"th-engine|splash", re.I)
# engine pids from session.out ("up after Ns pid=N", "splash ready after Ns pid=N pids=a,b")
ENGINE_PIDS = set()
try:
    for line in open(os.path.join(D, "session.out"), errors="replace"):
        m = re.search(r"pids=([\d,]+)", line)
        if m:
            ENGINE_PIDS.update(int(x) for x in m.group(1).split(",") if x)
        m = re.search(r"up after \d+s pid=(\d+)", line)
        if m:
            ENGINE_PIDS.add(int(m.group(1)))
except OSError:
    pass

def window(t0, t1):
    return [s for s in samples if t0 <= s["t"] <= t1 and s["idle"] is not None]

by_arm = collections.OrderedDict()
for r in sorted(recs, key=lambda r: r["wall_start"]):
    by_arm.setdefault(r["arm"], []).append(r)

print("| arm | engine | window | top samples | CPU idle % mean / min | load1 mean (top) | top non-engine CPU users (mean %CPU over window) |")
print("|---|---|---|---|---|---|---|")
for arm, rs in by_arm.items():
    t0 = rs[0]["wall_start"]; t1 = rs[-1]["wall_start"] + rs[-1]["total_ms"] / 1000
    w = window(t0, t1)
    if not w:
        print(f"| {arm} | {rs[0]['engine_name']} | — | 0 | — | — | — |"); continue
    idle = [s["idle"] for s in w]
    load = [s["load1"] for s in w if s["load1"] is not None]
    agg = collections.defaultdict(float)
    for s in w:
        for pid, cmd, cpu in s["procs"]:
            if not ENGINE.search(cmd) and pid not in ENGINE_PIDS:
                agg[f"{cmd}[{pid}]"] += cpu / len(w)
    top = sorted(agg.items(), key=lambda kv: -kv[1])[:5]
    ts = lambda x: datetime.datetime.fromtimestamp(x).strftime("%H:%M:%S")
    print(f"| {arm} | {rs[0]['engine_name']} | {ts(t0)}–{ts(t1)} | {len(w)} | {st.mean(idle):.1f} / {min(idle):.1f} | "
          f"{st.mean(load):.2f} | " + ", ".join(f"{k} {v:.0f}%" for k, v in top) + " |")

# per-request idle (for outlier checks)
if len(sys.argv) > 2 and sys.argv[2] == "req":
    for r in sorted(recs, key=lambda r: r["wall_start"]):
        w = window(r["wall_start"] - 1.5, r["wall_start"] + r["total_ms"] / 1000 + 1.5)
        idle = [s["idle"] for s in w]
        print(r["arm"], r["mode"], r["prompt"], r["iter"], f"{st.mean(idle):.1f}" if idle else "—")
