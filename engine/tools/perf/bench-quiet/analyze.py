#!/usr/bin/env python3
"""analyze.py SESSION_DIR [md|json] — bench-quiet aggregation (ratio-of-sums).

th (TH_DEBUG_TIMING [dflash] lines, log slice per request):
  loop tok/s = sum(emitted) / sum(step ms) over LOGGED rounds (first token + final unlogged round excluded)
  ms/round   = sum(step ms) / logged rounds;  tok/round = sum(emitted) / logged rounds
Splash (/status deltas per request):
  loop tok/s = sum(decode_output_tokens) / sum(decode_wall_ms); ms/round = wall / decode_batches;
  tok/round = decode_output_tokens / decode_batches   (decode_output_tokens == completion, i.e. it
  includes the prefill-sampled first token -> "corrected" variants subtract 1 per request)
Like-for-like client view (identical for both engines):
  client dec tok/s = sum(comp-1) / sum(total-TTFT); all-rounds tok/round = sum(comp-1) / sum(rounds_all)
  rounds_all = th logged+1, Splash decode_batches.
GPU-busy ms/round = least-squares slope of per-request ioreg GPU ms vs rounds_all (intercept absorbs prefill)."""
import collections, json, os, re, statistics as st, sys

DIRS = sys.argv[1].split(",")          # one or more session dirs (comma-separated)
MODE = sys.argv[2] if len(sys.argv) > 2 else "md"
MIN_IDLE = float(os.environ.get("BQ_MIN_IDLE", "0"))   # drop requests whose mean CPU idle (top) < this
recs = []
import datetime as _dt
def _top_samples(d):
    """(epoch, idle%) from the session's background `top -l 0 -s 3` log; first sample dropped."""
    out = []; t = None
    try:
        for line in open(os.path.join(d, "top.log"), errors="replace"):
            m = re.match(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})", line)
            if m:
                t = _dt.datetime.strptime(m.group(1), "%Y/%m/%d %H:%M:%S").timestamp(); continue
            m = re.search(r"CPU usage: .* ([\d.]+)% idle", line)
            if m and t is not None:
                out.append((t, float(m.group(1)))); t = None
    except OSError:
        pass
    return out[1:]
for d in DIRS:
    sess = os.path.basename(d.rstrip("/"))
    tops = _top_samples(d)
    for l in open(os.path.join(d, "runs.jsonl")):
        if not l.strip():
            continue
        r = json.loads(l)
        r["session"] = sess
        r["arm"] = f"{sess}:{r['arm']}" if len(DIRS) > 1 else r["arm"]
        a, b = r["wall_start"] - 1.5, r["wall_start"] + r["total_ms"] / 1000 + 1.5
        w = [i for t, i in tops if a <= t <= b]
        r["cpu_idle"] = st.mean(w) if w else None
        recs.append(r)
N_ALL = len(recs)
if MIN_IDLE > 0:
    recs = [r for r in recs if r["cpu_idle"] is None or r["cpu_idle"] >= MIN_IDLE]
N_KEPT = len(recs)

RE_DF = re.compile(r"\[dflash\] anchor=(\d+) prop=\[([^\]]*)\] emitted=\[([^\]]*)\] acc=(\d+) "
                   r"step=([\d.]+)ms propose=(\d+) verify=(\d+) rest=(\d+)")
RE_VF = re.compile(r"\[verify\] enqueue=([\d.]+)ms gpu\+readback=([\d.]+)ms")
_cache = {}
def slice_log(path, a, b):
    if path not in _cache:
        _cache[path] = open(path, "rb").read()
    return _cache[path][a:b].decode("utf-8", "replace")

import hashlib
def norm_text(t):
    # th streams the </think> token as content; Splash drops it at the reasoning->content switch
    return t.replace("</think>", "")
for r in recs:
    r["ntext"] = norm_text(r.get("text") or "")
    r["nsha"] = hashlib.sha1(r["ntext"].encode()).hexdigest()[:12]
for r in recs:
    R = {"kind": None}
    if r.get("log") and r.get("log_off0") is not None and r.get("log_off1") is not None:
        s = slice_log(r["log"], r["log_off0"], r["log_off1"])
        df = RE_DF.findall(s); vf = RE_VF.findall(s)
        R["kind"] = "th"
        R["logged"] = len(df)
        R["emitted"] = [[int(x) for x in m[2].split(",") if x.strip()] for m in df]
        R["tok"] = sum(len(e) for e in R["emitted"])
        R["step"] = sum(float(m[4]) for m in df)
        R["steps"] = [float(m[4]) for m in df]
        R["acc"] = [int(m[3]) for m in df]
        R["propose"] = sum(int(m[5]) for m in df); R["verify"] = sum(int(m[6]) for m in df)
        R["rest"] = sum(int(m[7]) for m in df)
        R["enqueue"] = sum(float(v[0]) for v in vf); R["gpu_rb"] = sum(float(v[1]) for v in vf)
        R["n_vf"] = len(vf)
        R["rounds_all"] = len(df) + 1
        ts = r.get("th_stats") or {}
        R["spec_rounds"] = ts.get("spec_rounds")
    elif r.get("status_delta"):
        sd = r["status_delta"]
        R["kind"] = "splash"
        R["logged"] = sd.get("scheduler.decode_batches", 0)
        R["rounds_all"] = R["logged"]
        R["tok"] = sd.get("metrics.decode_output_tokens", 0)
        R["step"] = sd.get("metrics.decode_wall_ms", 0.0)
        R["drafted"] = sd.get("metrics.drafted_tokens", 0); R["accepted"] = sd.get("metrics.accepted_draft_tokens", 0)
        R["reused"] = sd.get("cache.reused_tokens", 0); R["hits"] = sd.get("cache.hits", 0)
        R["b1"] = sd.get("scheduler.b1")
    r["R"] = R

def fit(xs, ys):
    n = len(xs)
    if n < 3:
        return None, None
    mx = sum(xs) / n; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None, None
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return my - b * mx, b

def agg(rows):
    ok = [r for r in rows if r["ok"] and r["R"]["kind"]]
    A = {"n": len(rows), "err": len(rows) - len(ok)}
    if not ok:
        return A
    kind = ok[0]["R"]["kind"]
    A["kind"] = kind
    L = sum(r["R"]["logged"] for r in ok); T = sum(r["R"]["tok"] for r in ok); S = sum(r["R"]["step"] for r in ok)
    RA = sum(r["R"]["rounds_all"] for r in ok)
    A.update(logged=L, rounds_all=RA, tok=T, step=S,
             ms_round=S / L if L else None, tok_round=T / L if L else None,
             loop_tps=T / S * 1000 if S else None)
    if kind == "splash":
        A["loop_tps_corr"] = (T - len(ok)) / S * 1000 if S else None
        A["tok_round_corr"] = (T - len(ok)) / L if L else None
        A["drafted"] = sum(r["R"]["drafted"] for r in ok); A["accepted"] = sum(r["R"]["accepted"] for r in ok)
        A["reused"] = [r["R"]["reused"] for r in ok]
        A["comp_eq_decout"] = all(r["R"]["tok"] == r["completion_tokens"] for r in ok)
    else:
        A["loop_tps_corr"] = A["loop_tps"]; A["tok_round_corr"] = A["tok_round"]
        A["propose"] = sum(r["R"]["propose"] for r in ok) / L if L else None
        A["verify"] = sum(r["R"]["verify"] for r in ok) / L if L else None
        A["rest"] = sum(r["R"]["rest"] for r in ok) / L if L else None
        nv = sum(r["R"]["n_vf"] for r in ok)
        A["enqueue"] = sum(r["R"]["enqueue"] for r in ok) / nv if nv else None
        A["gpu_rb"] = sum(r["R"]["gpu_rb"] for r in ok) / nv if nv else None
        steps = sorted(s for r in ok for s in r["R"]["steps"])
        if steps:
            A["step_p10"] = steps[int(0.1 * (len(steps) - 1))]; A["step_p50"] = steps[int(0.5 * (len(steps) - 1))]
            A["step_p90"] = steps[int(0.9 * (len(steps) - 1))]
        A["acc_hist"] = dict(sorted(collections.Counter(a for r in ok for a in r["R"]["acc"]).items()))
        A["spec_rounds_match"] = all(r["R"]["spec_rounds"] in (None, r["R"]["logged"]) for r in ok)
    dec_wall = sum(r["total_ms"] - r["ttft_ms"] for r in ok)
    dec_tok = sum(r["completion_tokens"] - 1 for r in ok)
    A.update(comp=sum(r["completion_tokens"] for r in ok), client_tps=dec_tok / dec_wall * 1000 if dec_wall else None,
             client_tok_round_all=dec_tok / RA if RA else None, client_ms_round_all=dec_wall / RA if RA else None)
    # like-for-like loop rate: tokens after the prefill-sampled first one, over ALL rounds (th: logged+1,
    # Splash: decode_batches), each round costed at the engine's own mean ms/round
    A["lfl_tps"] = (dec_tok / RA) / A["ms_round"] * 1000 if (RA and A.get("ms_round")) else None
    tt = [r["ttft_ms"] for r in ok]
    A.update(ttft_mean=st.mean(tt), ttft_med=st.median(tt), ttft_min=min(tt), ttft_max=max(tt))
    A["prompt_tok"] = sorted({r["prompt_tokens"] for r in ok})
    X = [r["R"]["rounds_all"] for r in ok]
    G = [r["engine_gpu_ms"] for r in ok if r.get("engine_gpu_ms") is not None]
    if len(G) == len(ok):
        A["gpu_icpt"], A["gpu_slope"] = fit(X, G)
        A["gpu_total"] = sum(G)
        A["gpu_ratio_round"] = sum(G) / RA  # includes prefill; upper bound per round
    C = [r["engine_cpu_ms"] for r in ok if r.get("engine_cpu_ms") is not None]
    if len(C) == len(ok):
        A["cpu_icpt"], A["cpu_slope"] = fit(X, C)
    W = [r["total_ms"] - r["ttft_ms"] for r in ok]
    A["wall_icpt"], A["wall_slope"] = fit(X, W)
    if A.get("gpu_slope") is not None and A.get("wall_slope") is not None:
        A["idle_slope"] = A["wall_slope"] - A["gpu_slope"]
    la = [r["loadavg1_start"] for r in ok]
    A["load_min"], A["load_max"], A["load_mean"] = min(la), max(la), st.mean(la)
    A["finish"] = dict(collections.Counter(r.get("finish") for r in ok))
    return A

def f(x, n=1):
    if x is None:
        return "—"
    if isinstance(x, float):
        return f"{x:.{n}f}"
    return str(x)

ENG_ORDER = {"th-integ": 0, "th-main": 1, "splash": 2}
MODE_ORDER = {"greedy": 0, "sampled": 1, "ctx1500": 2, "ctxcold": 3}
pooled = collections.OrderedDict()
for r in sorted(recs, key=lambda r: (ENG_ORDER.get(r["engine_name"], 9), MODE_ORDER.get(r["mode"], 9))):
    pooled.setdefault((r["engine_name"], r["mode"]), []).append(r)
per_arm = collections.OrderedDict()
for r in sorted(recs, key=lambda r: (MODE_ORDER.get(r["mode"], 9), r["wall_start"])):
    per_arm.setdefault((r["mode"], r["arm"], r["engine_name"]), []).append(r)
P = {k: agg(v) for k, v in pooled.items()}
PA = {k: agg(v) for k, v in per_arm.items()}

# ---------- token identity (T=0 modes) ----------
tok = None
try:
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(os.path.expanduser(
        "~/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots/"
        "10c35caafbb80f7dc6a7a432cdd11af10a6d4818/tokenizer.json"))
except Exception:
    pass

def first_div(a, b):
    n = min(len(a), len(b))
    i = next((k for k in range(n) if a[k] != b[k]), n)
    if i == len(a) == len(b):
        return None
    out = {"char": i}
    if tok is not None:
        ta = tok.encode(a, add_special_tokens=False).ids; tb = tok.encode(b, add_special_tokens=False).ids
        m = min(len(ta), len(tb))
        out["tok"] = next((k for k in range(m) if ta[k] != tb[k]), m)
    out["ctx"] = repr(a[max(0, i - 25):i]) + " | " + repr(a[i:i + 15]) + " vs " + repr(b[i:i + 15])
    return out

ident = collections.OrderedDict()
for r in recs:
    if r["ok"] and r["mode"] in ("greedy", "ctx1500", "ctxcold"):
        ident.setdefault((r["mode"], r["prompt"]), collections.OrderedDict()).setdefault(r["engine_name"], []).append(r)

def id_section():
    lines = []
    same_rounds = []
    for (mode, pr), d in ident.items():
        shas = {e: sorted({x["nsha"] for x in v}) for e, v in d.items()}
        det = {e: len(s) == 1 for e, s in shas.items()}
        lines.append(f"- **{mode} / {pr}**: " + "; ".join(
            f"{e}: {','.join(s)}{'' if det[e] else ' (NOT deterministic across repeats)'}" for e, s in shas.items()))
        engines = list(d.keys())
        texts = {e: d[e][0]["ntext"] for e in engines}
        for i in range(len(engines)):
            for j in range(i + 1, len(engines)):
                a, b = engines[i], engines[j]
                fd = first_div(texts[a], texts[b])
                if fd is None:
                    ca = d[a][0]["completion_tokens"]; cb = d[b][0]["completion_tokens"]
                    lines.append(f"  - {a} == {b}: byte-identical (after </think> normalisation; completion tokens {ca} vs {cb})")
                else:
                    lines.append(f"  - {a} vs {b}: first divergence at char {fd['char']}"
                                 + (f", token #{fd['tok']} (re-tokenized)" if 'tok' in fd else "") + f" — {fd['ctx']}")
        # rounds on identical text: groups of engines whose (single) text matches
        groups = collections.defaultdict(list)
        for e in engines:
            if det[e]:
                groups[shas[e][0]].append(e)
        for sha, es in groups.items():
            if len(es) >= 2:
                row = {"mode": mode, "prompt": pr, "sha": sha, "engines": {}}
                for e in es:
                    v = [x for x in d[e]]
                    ra = [x["R"]["rounds_all"] for x in v]
                    comp = v[0]["completion_tokens"]
                    row["engines"][e] = {"rounds_all": sorted(set(ra)), "comp": comp,
                                         "tok_round_all": (comp - 1) / st.mean(ra) if ra else None,
                                         "logged": sorted({x["R"]["logged"] for x in v})}
                same_rounds.append(row)
    return lines, same_rounds

def main_md():
    out = [f"_sessions: {', '.join(DIRS)}; requests kept {N_KEPT}/{N_ALL}" + (f" (CPU-idle filter >= {MIN_IDLE:.0f}%)" if MIN_IDLE > 0 else "") + "_\n"]
    out.append("### Pooled per engine × mode (both arms, ratio-of-sums)\n")
    out.append("| engine | mode | n | rounds (logged / all) | tok/round (engine conv.) | ms/round (engine) | **loop tok/s** | like-for-like loop tok/s | tok/round all-rounds (comp−1)/rounds | client ms/round all-rounds | client dec tok/s | TTFT mean / med (ms) | GPU-busy ms/round (slope) | host CPU ms/round (slope) | idle ms/round (wall−GPU slope) | load1 min–max |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (e, m), A in P.items():
        if not A.get("kind"):
            out.append(f"| {e} | {m} | {A['n']} ({A['err']} err) |"); continue
        out.append(f"| {e} | {m} | {A['n']}{'' if not A['err'] else ' (' + str(A['err']) + ' err)'} | {A['logged']} / {A['rounds_all']} | "
                   f"{f(A['tok_round'], 3)} | {f(A['ms_round'], 2)} | **{f(A['loop_tps'], 2)}** | {f(A['lfl_tps'], 2)} | "
                   f"{f(A['client_tok_round_all'], 3)} | {f(A['client_ms_round_all'], 2)} | {f(A['client_tps'], 2)} | {f(A['ttft_mean'], 0)} / {f(A['ttft_med'], 0)} | "
                   f"{f(A.get('gpu_slope'), 1)} | {f(A.get('cpu_slope'), 1)} | {f(A.get('idle_slope'), 1)} | {f(A['load_min'], 2)}–{f(A['load_max'], 2)} |")
    out.append("\n### Ratios (loop tok/s engine convention; like-for-like loop tok/s; client dec tok/s)\n")
    for m in ("greedy", "sampled", "ctx1500", "ctxcold"):
        def g(e, k="loop_tps"):
            return (P.get((e, m)) or {}).get(k)
        parts = []
        for a, b in (("th-integ", "splash"), ("th-main", "splash"), ("th-integ", "th-main")):
            x, y = g(a), g(b); cx, cy = g(a, "client_tps"), g(b, "client_tps")
            lx, ly = g(a, "lfl_tps"), g(b, "lfl_tps")
            if x and y:
                parts.append(f"{a}/{b} = **{x / y:.3f}** (like-for-like {lx / ly:.3f}; client {cx / cy:.3f})")
        out.append(f"- {m}: " + "; ".join(parts))
    out.append("\n### Per arm (drift check; session order)\n")
    out.append("| mode | arm | engine | n | rounds logged/all | tok/round | ms/round | loop tok/s | client dec tok/s | TTFT mean | GPU slope | load1 mean |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for (m, a, e), A in PA.items():
        if not A.get("kind"):
            continue
        out.append(f"| {m} | {a} | {e} | {A['n']} | {A['logged']}/{A['rounds_all']} | {f(A['tok_round'], 3)} | {f(A['ms_round'], 2)} | {f(A['loop_tps'], 2)} | "
                   f"{f(A['client_tps'], 2)} | {f(A['ttft_mean'], 0)} | {f(A.get('gpu_slope'), 1)} | {f(A['load_mean'], 2)} |")
    out.append("\n### Per prompt (pooled arms)\n")
    out.append("| engine | mode | prompt | n | rounds logged/all | tok/round | ms/round | loop tok/s | client dec tok/s | TTFT mean | distinct texts |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    pp = collections.OrderedDict()
    for r in sorted(recs, key=lambda r: (MODE_ORDER.get(r["mode"], 9), ["short", "code", "long"].index(r["prompt"]) if r["prompt"] in ("short", "code", "long") else 9, ENG_ORDER.get(r["engine_name"], 9))):
        pp.setdefault((r["engine_name"], r["mode"], r["prompt"]), []).append(r)
    for (e, m, pr), v in pp.items():
        A = agg(v)
        if not A.get("kind"):
            continue
        out.append(f"| {e} | {m} | {pr} | {A['n']} | {A['logged']}/{A['rounds_all']} | {f(A['tok_round'], 3)} | {f(A['ms_round'], 2)} | {f(A['loop_tps'], 2)} | "
                   f"{f(A['client_tps'], 2)} | {f(A['ttft_mean'], 0)} | {len({x['nsha'] for x in v})} |")
    out.append("\n### th per-round breakdown (mean per logged round)\n")
    for (e, m), A in P.items():
        if A.get("kind") == "th":
            out.append(f"- {e} {m}: propose {f(A['propose'])} + verify {f(A['verify'])} + rest {f(A['rest'])} ms "
                       f"([verify] enqueue {f(A['enqueue'])} ms incl. propose, gpu+readback {f(A['gpu_rb'])} ms); "
                       f"step p10/p50/p90 {f(A.get('step_p10'))}/{f(A.get('step_p50'))}/{f(A.get('step_p90'))}; acc hist {A['acc_hist']}; "
                       f"prompt tok {A['prompt_tok']}; finish {A['finish']}; spec_rounds==logged: {A['spec_rounds_match']}")
        elif A.get("kind") == "splash":
            out.append(f"- {e} {m}: drafted {A['drafted']} accepted {A['accepted']} (rate {A['accepted'] / A['drafted'] if A['drafted'] else 0:.3f}); "
                       f"prefix-cache reused tokens per request {A['reused']}; decode_output_tokens==completion: {A['comp_eq_decout']}; "
                       f"prompt tok {A['prompt_tok']}; finish {A['finish']}")
    lines, same = id_section()
    out.append("\n### T=0 token identity (greedy, ctx1500, ctxcold)\n")
    out.extend(lines)
    out.append("\n### Rounds on byte-identical greedy text (normalised sha1 = sha1 of text with </think> removed)\n")
    out.append("| mode | prompt | text sha1 | engine | completion | rounds_all (th logged+1 / Splash decode_batches) | tok/round (comp−1)/rounds_all |")
    out.append("|---|---|---|---|---|---|---|")
    for row in same:
        for e, v in row["engines"].items():
            out.append(f"| {row['mode']} | {row['prompt']} | {row['sha']} | {e} | {v['comp']} | {v['rounds_all']} | {f(v['tok_round_all'], 3)} |")
    out.append("\n### Identical-text totals, pairwise (groups where both engines emitted the same normalised text)\n")
    out.append("| pair | groups | tokens (Σ comp−1) | rounds A | rounds B | tok/round A | tok/round B | B/A rounds |")
    out.append("|---|---|---|---|---|---|---|---|")
    for a, b in (("th-integ", "splash"), ("th-main", "splash"), ("th-integ", "th-main")):
        g = 0; T = 0; RA_ = 0; RB_ = 0
        for row in same:
            if a in row["engines"] and b in row["engines"]:
                ea, eb = row["engines"][a], row["engines"][b]
                if len(ea["rounds_all"]) != 1 or len(eb["rounds_all"]) != 1:
                    continue
                g += 1; T += ea["comp"] - 1; RA_ += ea["rounds_all"][0]; RB_ += eb["rounds_all"][0]
        if g:
            out.append(f"| {a} vs {b} | {g} | {T} | {RA_} | {RB_} | {T / RA_:.3f} | {T / RB_:.3f} | {RB_ / RA_:.3f} |")
    out.append("\n### TTFT detail (ms; mean/median/min/max)\n")
    for (e, m), A in P.items():
        if A.get("kind"):
            out.append(f"- {e} {m}: {f(A['ttft_mean'], 0)} / {f(A['ttft_med'], 0)} / {f(A['ttft_min'], 0)} / {f(A['ttft_max'], 0)}"
                       + (f"; Splash prefix-cache reused tokens {A['reused']}" if A['kind'] == 'splash' else ""))
    return "\n".join(out)

def raw_md():
    out = ["| arm | engine | mode | prompt#i | seed | p_tok | comp | fin | TTFT | total | rounds all | tok/round all | ms/round (engine) | GPU ms | CPU ms | load1 | CPU idle % | sha1 (norm) |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in sorted(recs, key=lambda r: r["wall_start"]):
        R = r["R"]
        if not r["ok"] or not R.get("kind"):
            out.append(f"| {r['arm']} | {r['engine_name']} | {r['mode']} | {r['prompt']}#{r['iter']} | ERR {r.get('error')} |"); continue
        ra = R["rounds_all"]
        out.append(f"| {r['arm']} | {r['engine_name']} | {r['mode']} | {r['prompt']}#{r['iter']} | {r.get('seed')} | {r['prompt_tokens']} | {r['completion_tokens']} | {r['finish']} | "
                   f"{f(r['ttft_ms'], 0)} | {f(r['total_ms'], 0)} | {ra} | {f((r['completion_tokens'] - 1) / ra if ra else None, 2)} | "
                   f"{f(R['step'] / R['logged'] if R['logged'] else None, 1)} | {f(r.get('engine_gpu_ms'), 0)} | {f(r.get('engine_cpu_ms'), 0)} | {f(r['loadavg1_start'], 2)} | {f(r.get('cpu_idle'), 0)} | {r['nsha']} |")
    return "\n".join(out)

if MODE == "json":
    lines, same = id_section()
    print(json.dumps({"pooled": {"|".join(k): v for k, v in P.items()}, "per_arm": {"|".join(k): v for k, v in PA.items()},
                      "identity": lines, "same_text_rounds": same}, indent=1, default=str))
elif MODE == "raw":
    print(raw_md())
else:
    print(main_md())
