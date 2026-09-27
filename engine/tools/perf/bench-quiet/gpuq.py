#!/usr/bin/env python3
"""GPU contention probe (macOS, Apple GPU): per-pid accumulatedGPUTime (ns)
from IOAccelerator user clients + "Device Utilization %".
  gpuq.py check [secs=3] [--exclude pid,..]   util samples + per-pid GPU ms/s
  gpuq.py snap OUT.json                        snapshot (arm start/end deltas)
  gpuq.py delta A.json B.json [--exclude ..]   per-pid GPU ms over the interval
  gpuq.py waitquiet [thr_ms_per_s=60] [window=3] [timeout=300] [--exclude ..]
"""
import json, re, subprocess, sys, time

def _ioreg():
    return subprocess.run(["ioreg", "-lw0", "-r", "-c", "IOAccelerator"],
                          capture_output=True, text=True).stdout

def snapshot():
    txt = _ioreg()
    util = None
    m = re.search(r'"Device Utilization %"=(\d+)', txt)
    if m:
        util = int(m.group(1))
    per = {}
    for block in re.split(r"\n[ |]*\+-o ", txt):
        c = re.search(r'"IOUserClientCreator" = "pid (\d+), ([^"]*)"', block)
        if not c:
            continue
        pid, name = int(c.group(1)), c.group(2)
        ns = sum(int(x) for x in re.findall(r'"accumulatedGPUTime"=(\d+)', block))
        e = per.setdefault(pid, {"name": name, "gpu_ns": 0})
        e["gpu_ns"] += ns
    return {"t": time.time(), "util": util, "pids": per}

def delta(a, b, exclude=()):
    dt = b["t"] - a["t"]
    rows = []
    for pid, eb in b["pids"].items():
        pid = int(pid)
        ea = a["pids"].get(pid) or {"gpu_ns": 0}
        d = eb["gpu_ns"] - ea["gpu_ns"]
        if d > 0:
            rows.append((d / 1e6, pid, eb["name"]))
    rows.sort(reverse=True)
    other = sum(r[0] for r in rows if r[1] not in exclude)
    return dt, rows, other

def fmt_rows(rows, dt, n=8):
    return ", ".join(f"{name}[{pid}] {ms:.0f}ms ({ms/dt/10:.1f}%)" for ms, pid, name in rows[:n])

def check(secs=3.0, exclude=()):
    a = snapshot()
    utils = []
    t_end = time.time() + secs
    while time.time() < t_end:
        s = snapshot()
        if s["util"] is not None:
            utils.append(s["util"])
        time.sleep(0.25)
    b = snapshot()
    dt, rows, other = delta(a, b, exclude)
    u = utils or [0]
    return {"at": time.strftime("%H:%M:%S"), "window_s": round(dt, 2),
            "util_min": min(u), "util_mean": round(sum(u) / len(u), 1), "util_max": max(u),
            "other_gpu_ms_per_s": round(other / dt, 1), "top": fmt_rows(rows, dt)}

def _load(p):
    d = json.load(open(p))
    d["pids"] = {int(k): v for k, v in d["pids"].items()}
    return d

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    excl = ()
    if "--exclude" in sys.argv:
        i = sys.argv.index("--exclude")
        excl = tuple(int(x) for x in sys.argv[i + 1].split(",") if x)
        del sys.argv[i:i + 2]
    if cmd == "check":
        print(json.dumps(check(float(sys.argv[2]) if len(sys.argv) > 2 else 3.0, excl)))
    elif cmd == "snap":
        json.dump(snapshot(), open(sys.argv[2], "w"))
    elif cmd == "delta":
        a, b = _load(sys.argv[2]), _load(sys.argv[3])
        dt, rows, other = delta(a, b, excl)
        print(json.dumps({"window_s": round(dt, 1), "other_gpu_ms": round(other, 1),
                          "other_gpu_ms_per_s": round(other / dt, 1),
                          "per_pid_ms": {f"{n}[{p}]": round(ms, 1) for ms, p, n in rows[:12]},
                          "top": fmt_rows(rows, dt, 10)}))
    elif cmd == "waitquiet":
        thr = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
        win = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
        tmo = float(sys.argv[4]) if len(sys.argv) > 4 else 300.0
        t0 = time.time()
        while True:
            r = check(win, excl)
            r["waited_s"] = round(time.time() - t0, 1)
            if r["other_gpu_ms_per_s"] <= thr:
                r["quiet"] = True
                print(json.dumps(r)); break
            if time.time() - t0 > tmo:
                r["quiet"] = False
                print(json.dumps(r)); break
            sys.stderr.write("busy: " + json.dumps(r) + "\n")
