#!/usr/bin/env python3
"""Aggregate runs.jsonl (+ th-engine TH_DEBUG_TIMING log slices, Splash /status
deltas) into ratio-of-sums per-round stats. Prints markdown."""
import json, re, statistics as st, sys, collections

RUNS = sys.argv[1]
recs = [json.loads(l) for l in open(RUNS) if l.strip()]

RE_DF = re.compile(r"\[dflash\] anchor=(\d+) prop=\[([^\]]*)\] emitted=\[([^\]]*)\] acc=(\d+) "
                   r"step=([\d.]+)ms propose=(\d+) verify=(\d+) rest=(\d+)")
RE_VF = re.compile(r"\[verify\] enqueue=([\d.]+)ms gpu\+readback=([\d.]+)ms")
RE_BA = re.compile(r"\[batch\] nb=(\d+) propose=([\d.]+)ms verify=([\d.]+)ms total=([\d.]+)ms")
RE_PB = re.compile(r"\[pb\] (cand_tables|walks)=([\d.]+)ms")

_cache = {}
def slice_log(path, a, b):
    if path not in _cache:
        _cache[path] = open(path, "rb").read()
    return _cache[path][a:b].decode("utf-8", "replace")

def parse(r):
    """Attach per-request round stats to r['rounds']."""
    out = {"kind": None}
    if r.get("log") and r.get("log_off0") is not None and r.get("log_off1") is not None:
        s = slice_log(r["log"], r["log_off0"], r["log_off1"])
        df = RE_DF.findall(s)
        ba = RE_BA.findall(s)
        if df:
            out["kind"] = "th-dflash"
            em = [len([x for x in m[2].split(",") if x.strip()]) for m in df]
            out.update(rounds_logged=len(df), emitted=em, acc=[int(m[3]) for m in df],
                       step=[float(m[4]) for m in df], propose=[int(m[5]) for m in df],
                       verify=[int(m[6]) for m in df], rest=[int(m[7]) for m in df])
            vf = RE_VF.findall(s)
            out["enqueue"] = [float(v[0]) for v in vf]
            out["gpu_rb"] = [float(v[1]) for v in vf]
        elif ba:
            out["kind"] = "th-batch"
            out.update(rounds_logged=len(ba), nb=[int(m[0]) for m in ba],
                       b_propose=[float(m[1]) for m in ba], b_verify=[float(m[2]) for m in ba],
                       b_total=[float(m[3]) for m in ba])
            pb = RE_PB.findall(s)
            out["cand_tables"] = [float(v) for k, v in pb if k == "cand_tables"]
            out["walks"] = [float(v) for k, v in pb if k == "walks"]
    elif r.get("status_delta"):
        out["kind"] = "splash"
        out.update(r["status_delta"])
    r["rounds"] = out
    return r

for r in recs:
    parse(r)

def pct(v, q):
    if not v:
        return None
    v = sorted(v)
    k = (len(v) - 1) * q
    f = int(k); c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)

def agg(rows):
    ok = [r for r in rows if r["ok"]]
    A = {"n": len(rows), "err": len(rows) - len(ok)}
    if not ok:
        return A
    ttft = [r["ttft_ms"] for r in ok if r["ttft_ms"]]
    A["ttft_mean"] = st.mean(ttft); A["ttft_med"] = st.median(ttft)
    A["ttft_min"] = min(ttft); A["ttft_max"] = max(ttft)
    A["comp"] = sum(r["completion_tokens"] or 0 for r in ok)
    A["prompt_tok"] = sorted({r["prompt_tokens"] for r in ok})
    dec_wall = sum(r["total_ms"] - r["ttft_ms"] for r in ok)
    dec_tok = sum((r["completion_tokens"] or 1) - 1 for r in ok)
    A["client_dec_wall_ms"] = dec_wall; A["client_dec_tok"] = dec_tok
    A["client_tps"] = dec_tok / dec_wall * 1000 if dec_wall else None
    # what the stock bench-engines.sh would print (mean of per-request, engine-preferred)
    d = [r.get("engine_decode_tps") or r.get("decode_tps") for r in ok]
    d = [x for x in d if x]
    A["script_decode_tps"] = st.mean(d) if d else None
    w = [r["decode_tps"] for r in ok if r.get("decode_tps")]
    A["script_wall_decode_tps"] = st.mean(w) if w else None
    g = [r.get("engine_gpu_ms") for r in ok if r.get("engine_gpu_ms") is not None]
    A["engine_gpu_ms"] = sum(g) if g else None
    A["finish"] = dict(collections.Counter(r.get("finish") for r in ok))
    kinds = {r["rounds"]["kind"] for r in ok}
    A["kind"] = ",".join(sorted(k or "none" for k in kinds))
    R = [r["rounds"] for r in ok]
    if kinds == {"th-dflash"}:
        rl = sum(x["rounds_logged"] for x in R)
        em = sum(sum(x["emitted"]) for x in R)
        stp = sum(sum(x["step"]) for x in R)
        allstep = [s for x in R for s in x["step"]]
        A.update(rounds=rl, tokens=em, step_ms=stp,
                 ms_round=stp / rl, tok_round=em / rl, loop_tps=em / stp * 1000,
                 propose=sum(sum(x["propose"]) for x in R) / rl,
                 verify=sum(sum(x["verify"]) for x in R) / rl,
                 rest=sum(sum(x["rest"]) for x in R) / rl,
                 enqueue=(sum(sum(x["enqueue"]) for x in R) / max(1, sum(len(x["enqueue"]) for x in R))),
                 gpu_rb=(sum(sum(x["gpu_rb"]) for x in R) / max(1, sum(len(x["gpu_rb"]) for x in R))),
                 step_p10=pct(allstep, .1), step_p50=pct(allstep, .5), step_p90=pct(allstep, .9),
                 acc_hist=dict(sorted(collections.Counter(a for x in R for a in x["acc"]).items())),
                 emit_hist=dict(sorted(collections.Counter(e for x in R for e in x["emitted"]).items())))
        # client-side view with the (always unlogged) final round included
        rall = sum(x["rounds_logged"] + 1 for x in R)
        A.update(rounds_all=rall, client_ms_round=dec_wall / rall, client_tok_round=dec_tok / rall)
        if A["engine_gpu_ms"] is not None:
            A["gpu_ms_round"] = A["engine_gpu_ms"] / rall
    elif kinds == {"th-batch"}:
        rl = sum(x["rounds_logged"] for x in R)
        A.update(rounds=rl, rounds_all=rl,
                 nb_values=sorted({n for x in R for n in x["nb"]}),
                 client_ms_round=dec_wall / rl, client_tok_round=dec_tok / rl,
                 logged_total_ms_round=sum(sum(x["b_total"]) for x in R) / rl,
                 logged_propose=sum(sum(x["b_propose"]) for x in R) / rl,
                 logged_verify_enq=sum(sum(x["b_verify"]) for x in R) / rl,
                 cand_tables=(sum(sum(x["cand_tables"]) for x in R) / rl),
                 walks=(sum(sum(x["walks"]) for x in R) / rl))
        A["ms_round"] = A["client_ms_round"]; A["tok_round"] = A["client_tok_round"]
        A["loop_tps"] = A["client_tps"]
        if A["engine_gpu_ms"] is not None:
            A["gpu_ms_round"] = A["engine_gpu_ms"] / rl
    elif kinds == {"splash"}:
        rl = sum(x.get("scheduler.decode_batches", 0) for x in R)
        b1 = sum(x.get("scheduler.b1", 0) for x in R)
        tok = sum(x.get("metrics.decode_output_tokens", 0) for x in R)
        wall = sum(x.get("metrics.decode_wall_ms", 0) for x in R)
        dr = sum(x.get("metrics.drafted_tokens", 0) for x in R)
        ac = sum(x.get("metrics.accepted_draft_tokens", 0) for x in R)
        A.update(rounds=rl, rounds_b1=b1, tokens=tok, step_ms=wall,
                 ms_round=wall / rl if rl else None, tok_round=tok / rl if rl else None,
                 loop_tps=tok / wall * 1000 if wall else None,
                 drafted=dr, accepted=ac,
                 cache_hits=sum(x.get("cache.hits", 0) for x in R),
                 reused_tokens=sum(x.get("cache.reused_tokens", 0) for x in R),
                 rounds_all=rl, client_ms_round=dec_wall / rl if rl else None,
                 client_tok_round=dec_tok / rl if rl else None)
        if A["engine_gpu_ms"] is not None and rl:
            A["gpu_ms_round"] = A["engine_gpu_ms"] / rl
    return A

def f(x, n=1):
    if x is None:
        return "—"
    if isinstance(x, float):
        return f"{x:.{n}f}"
    return str(x)

groups = collections.OrderedDict()
for r in recs:
    groups.setdefault((r["engine_name"], r["mode"], r["arm"]), []).append(r)
pooled = collections.OrderedDict()
for r in recs:
    pooled.setdefault((r["engine_name"], r["mode"]), []).append(r)

mode = sys.argv[2] if len(sys.argv) > 2 else "md"
if mode == "json":
    print(json.dumps({"per_arm": {"|".join(k): agg(v) for k, v in groups.items()},
                      "pooled": {"|".join(k): agg(v) for k, v in pooled.items()}}, indent=1, default=str))
    sys.exit()

print("### Pooled (both arms per engine), ratio-of-sums\n")
print("| engine | mode | n | rounds | tok/round | ms/round | loop tok/s | client dec tok/s | client ms/round | TTFT mean / med (ms) | script decode_tps (stock metric) | GPU ms/round |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for (e, m), v in pooled.items():
    A = agg(v)
    print(f"| {e} | {m} | {A['n']}{'' if not A['err'] else ' ('+str(A['err'])+' err)'} | {f(A.get('rounds'))} | {f(A.get('tok_round'),3)} | {f(A.get('ms_round'))} | {f(A.get('loop_tps'))} | {f(A.get('client_tps'))} | {f(A.get('client_ms_round'))} | {f(A.get('ttft_mean'),0)} / {f(A.get('ttft_med'),0)} | {f(A.get('script_decode_tps'))} | {f(A.get('gpu_ms_round'))} |")

print("\n### Per arm\n")
print("| arm | engine | mode | n | rounds | tok/round | ms/round | loop tok/s | client dec tok/s | TTFT mean (ms) | comp tok | finish |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for (e, m, a), v in groups.items():
    A = agg(v)
    print(f"| {a} | {e} | {m} | {A['n']} | {f(A.get('rounds'))} | {f(A.get('tok_round'),3)} | {f(A.get('ms_round'))} | {f(A.get('loop_tps'))} | {f(A.get('client_tps'))} | {f(A.get('ttft_mean'),0)} | {A.get('comp')} | {A.get('finish')} |")

print("\n### Per-round breakdown (engine-internal)\n")
for (e, m), v in pooled.items():
    A = agg(v)
    if A.get("kind") == "th-dflash":
        print(f"- {e} {m}: step p10/p50/p90 = {f(A['step_p10'])}/{f(A['step_p50'])}/{f(A['step_p90'])} ms; "
              f"mean propose {f(A['propose'])} + verify {f(A['verify'])} + rest {f(A['rest'])} ms "
              f"([verify] enqueue {f(A['enqueue'])} ms, gpu+readback {f(A['gpu_rb'])} ms); "
              f"acc hist {A['acc_hist']}; emitted/round hist {A['emit_hist']}; "
              f"client view incl. final unlogged round: {A['rounds_all']} rounds, {f(A['client_tok_round'],3)} tok/round, {f(A['client_ms_round'])} ms/round")
    elif A.get("kind") == "th-batch":
        print(f"- {e} {m}: nb values {A['nb_values']}; logged [batch] total {f(A['logged_total_ms_round'])} ms/round "
              f"(propose {f(A['logged_propose'])}, verify-enqueue {f(A['logged_verify_enq'])}; [pb] cand_tables {f(A['cand_tables'])}, walks {f(A['walks'])}) "
              f"— NOTE batched build's step_ms stops at verify enqueue, excludes GPU wait/accept/commit; ms/round above is client wall/rounds")
    elif A.get("kind") == "splash":
        print(f"- {e} {m}: /status deltas: decode_batches {A['rounds']} (b1 {A['rounds_b1']}), decode_output_tokens {A['tokens']}, "
              f"decode_wall_ms {f(A['step_ms'])}; drafted {A['drafted']} accepted {A['accepted']} "
              f"(accept rate {f(A['accepted']/A['drafted'] if A['drafted'] else None,3)}); prefix-cache hits {A['cache_hits']} reused tokens {A['reused_tokens']}; "
              f"client view {f(A['client_tok_round'],3)} tok/round, {f(A['client_ms_round'])} ms/round")
    print(f"  prompt_tokens {A.get('prompt_tok')}, completion tokens {A.get('comp')}, finish {A.get('finish')}, engine GPU ms total {f(A.get('engine_gpu_ms'),0)}")

print("\n### Per-request raw\n")
print("| arm | engine | mode | prompt#i | p_tok | comp | ttft ms | total ms | rounds | tok/round | ms/round(int) | client ms/round | GPU ms | sha1 |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in recs:
    R = r["rounds"]; k = R.get("kind")
    if not r["ok"]:
        print(f"| {r['arm']} | {r['engine_name']} | {r['mode']} | {r['prompt']}#{r['iter']} | ERR {r['error']} |")
        continue
    dt = r["total_ms"] - r["ttft_ms"]; dtok = (r["completion_tokens"] or 1) - 1
    if k == "th-dflash":
        rl = R["rounds_logged"]; ra = rl + 1
        tr = f(sum(R["emitted"]) / rl, 2) if rl else "—"; mr = f(sum(R["step"]) / rl) if rl else "—"
    elif k == "th-batch":
        ra = R["rounds_logged"]; tr = f(dtok / ra, 2) if ra else "—"; mr = "(n/a)"
    elif k == "splash":
        ra = R.get("scheduler.decode_batches", 0)
        tr = f(R.get("metrics.decode_output_tokens", 0) / ra, 2) if ra else "—"
        mr = f(R.get("metrics.decode_wall_ms", 0) / ra) if ra else "—"
    else:
        ra = 0; tr = mr = "—"
    cm = f(dt / ra) if ra else "—"
    print(f"| {r['arm']} | {r['engine_name']} | {r['mode']} | {r['prompt']}#{r['iter']} | {r['prompt_tokens']} | {r['completion_tokens']} | {f(r['ttft_ms'],0)} | {f(r['total_ms'],0)} | {ra} | {tr} | {mr} | {cm} | {f(r.get('engine_gpu_ms'),0)} | {r['text_sha1']} |")

print("\n### Greedy (T=0) output identity\n")
gre = [r for r in recs if r["mode"] == "greedy" and r["ok"]]
byp = collections.OrderedDict()
for r in gre:
    byp.setdefault(r["prompt"], collections.OrderedDict()).setdefault(f"{r['engine_name']}@{r['arm']}", []).append(r["text_sha1"])
for p, d in byp.items():
    print(f"- {p}: " + "; ".join(f"{k}: {','.join(v)}" for k, v in d.items()))
