#!/usr/bin/env python3
"""headline.py SESSION_DIR... — compact per-session headline rows from analysis.json (run analyze.py DIR json first)."""
import json, os, sys
BUILD = {"th-integ": "8d5b6d5 (sha256 e91a30d2afb7)", "th-main": "cf3e5f7 (sha256 1f4fbca344ce)", "splash": "Splash 1.0 brew"}
for d in sys.argv[1:]:
    A = json.load(open(os.path.join(d, "analysis.json")))["pooled"]
    s = os.path.basename(d.rstrip("/"))
    print(f"### {s}\n")
    print("| engine | build | mode | n req | rounds (logged) | tok/round | ms/round | loop tok/s | like-for-like tok/s | client dec tok/s | TTFT mean / med ms | GPU-busy ms/round | idle ms/round | load1 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for k, v in A.items():
        e, m = k.split("|")
        f = lambda x, n=2: "—" if x is None else f"{x:.{n}f}"
        print(f"| {e} | {BUILD.get(e, '?')} | {m} | {v['n']} | {v['logged']} | {f(v['tok_round'], 3)} | {f(v['ms_round'])} | **{f(v['loop_tps'])}** | {f(v['lfl_tps'])} | {f(v['client_tps'])} | "
              f"{f(v['ttft_mean'], 0)} / {f(v['ttft_med'], 0)} | {f(v.get('gpu_slope'), 1)} | {f(v.get('idle_slope'), 1)} | {f(v['load_min'])}–{f(v['load_max'])} |")
    def r(a, b, m, k="loop_tps"):
        x = A.get(f"{a}|{m}", {}).get(k); y = A.get(f"{b}|{m}", {}).get(k)
        return x / y if x and y else None
    print()
    for m in ("greedy", "sampled", "ctx1500", "ctxcold"):
        vals = [(a, b, r(a, b, m), r(a, b, m, "lfl_tps"), r(b, a, m, "ms_round"), r(a, b, m, "tok_round")) for a, b in (("th-integ", "splash"), ("th-main", "splash"), ("th-integ", "th-main"))]
        print(f"- {m}: " + "; ".join(f"{a}/{b} loop {x:.3f} (lfl {y:.3f}; ms/round ratio {z:.3f}; tok/round ratio {w:.3f})" for a, b, x, y, z, w in vals if x))
    print()
