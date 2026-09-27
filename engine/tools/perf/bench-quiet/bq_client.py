#!/usr/bin/env python3
"""bq_client.py — bench-quiet per-arm client (one process per arm, sequential requests).

  bq_client.py --port P --engine NAME --arm LABEL --out runs.jsonl
               [--log SERVER_STDERR_LOG] [--status-delta] [--pids pid,..] [--passage FILE]

Suite per arm (same for every engine):
  warm-up (unrecorded in --out, written to <out>.warmup.jsonl):
      short "Say hi." T=0 max 32; ctx passage+"Say hi." T=0 max 32
  greedy  : 3 bench prompts x 3 iterations, T=0, max_tokens 128
  sampled : 3 bench prompts x seeds 1,3,5, T=0.6 / top_p 0.95 / top_k 20, max_tokens 128
  ctx1500 : passage (~1373 tok) + "\\n\\n" + bench prompt, 3 x 3, T=0, max_tokens 128
  ctxcold : "Note <k>.\\n" + passage + "\\n\\n" + bench prompt k, 1 per prompt, T=0, max_tokens 128 —
            the leading nonce defeats Splash's prefix cache (only the 32-token template block can
            match), so its TTFT is a cold ~1440-token prefill on both engines (fresh server per arm)
Per request the SSE measurement is the bench-engines-port.sh measure(): readline(),
TTFT = first content/reasoning delta, completion tokens engine-reported. All probes
(ioreg GPU ns, ps CPU time, /status, log offsets, loadavg) run outside the timed window.
Record schema is a superset of bench-engines-port.sh's BENCH_RUNS_JSONL records, so
_phaseC/bin/aggregate.py can also read it."""
import argparse, hashlib, json, os, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gpuq  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--engine", required=True)
ap.add_argument("--arm", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--log", default="")
ap.add_argument("--status-delta", action="store_true")
ap.add_argument("--pids", default="")
ap.add_argument("--passage", default=os.path.join(HERE, "passage.txt"))
ap.add_argument("--max-tokens", type=int, default=128)
ap.add_argument("--iters", type=int, default=3)
ap.add_argument("--modes", default="greedy,sampled,ctx1500,ctxcold")
A = ap.parse_args()

BASE = f"http://127.0.0.1:{A.port}"
URL = BASE + "/v1/chat/completions"
PIDS = [int(x) for x in A.pids.split(",") if x.strip()]
PASSAGE = open(A.passage).read()
PASSAGE_SHA1 = hashlib.sha1(PASSAGE.encode()).hexdigest()[:12]
BENCH = [
    ("short", "Reply with exactly: hello world"),
    ("code", "Write a Python function that reverses a linked list. Include a docstring."),
    ("long", "Summarise the key design constraints of the UNIX process model: file descriptors, fork/exec, signals, and pipes. Two sentences each."),
]
SEEDS = (1, 3, 5)  # odd: th's sampler seeds with seed|1

def get_json(path, timeout=10):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None

st = get_json("/status") or {}
MODEL = (st.get("instance") or {}).get("model") or (st.get("model") if isinstance(st.get("model"), str) else None) or "th"

def log_size():
    try:
        return os.path.getsize(A.log) if A.log else None
    except OSError:
        return None

def gpu_ns():
    if not PIDS:
        return None
    try:
        snap = gpuq.snapshot()["pids"]
        return sum(snap.get(p, {}).get("gpu_ns", 0) for p in PIDS)
    except Exception:
        return None

def cpu_ms():
    if not PIDS:
        return None
    tot = 0.0
    for p in PIDS:
        t = subprocess.run(["ps", "-o", "time=", "-p", str(p)], capture_output=True, text=True).stdout.strip()
        if not t:
            continue
        parts = t.split(":")
        secs = float(parts[-1]) + 60 * float(parts[-2]) + (3600 * float(parts[-3]) if len(parts) > 2 else 0)
        tot += secs * 1000
    return tot

def sdelta(a, b):
    if not (a and b):
        return None
    out = {}
    for sec, keys in (("metrics", ("decode_output_tokens", "decode_wall_ms", "drafted_tokens",
                                   "accepted_draft_tokens", "prefill_input_tokens", "prefill_wall_ms")),
                      ("scheduler", ("decode_batches", "prefill_batches", "prefill_rows")),
                      ("cache", ("hits", "cold_misses", "reused_tokens")),
                      ("requests", ("completed", "total"))):
        for k in keys:
            try:
                out[f"{sec}.{k}"] = b[sec][k] - a[sec][k]
            except Exception:
                pass
    try:
        out["scheduler.b1"] = (b["scheduler"]["decode_batches_by_width"]["b1"]
                               - a["scheduler"]["decode_batches_by_width"]["b1"])
    except Exception:
        pass
    return out

def thermal_level():
    try:
        out = subprocess.run(["notifyutil", "-g", "com.apple.system.thermalpressurelevel"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[-1])
    except Exception:
        return None

def measure(mode, pname, it, content, max_tokens, samp, seed, out_path):
    body = {"model": MODEL, "messages": [{"role": "user", "content": content}],
            "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True}}
    body.update(samp)
    if seed is not None:
        body["seed"] = seed
    data = json.dumps(body).encode()
    th0 = thermal_level()
    st0 = get_json("/status") if A.status_delta else None
    c0 = cpu_ms()
    load0 = os.getloadavg()
    g0 = gpu_ns()
    off0 = log_size()
    wall0 = time.time()
    t0 = time.monotonic()
    ttft = None; usage = {}; engine = {}; err = None; deltas = []; finish = None; first_delta = None; kinds = []
    try:
        req = urllib.request.Request(URL, data=data, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            while True:
                raw = r.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                d = line[5:].strip()
                if d == "[DONE]":
                    break
                try:
                    obj = json.loads(d)
                except json.JSONDecodeError:
                    continue
                if obj.get("usage"):
                    usage = obj["usage"]
                if obj.get("th_stats"):
                    engine = obj["th_stats"]
                if obj.get("metrics"):
                    m = obj["metrics"].get("request_latency") or {}
                    engine.setdefault("decode_tps", m.get("stream_tokens_per_second"))
                    engine.setdefault("ttft_ms", m.get("ttft_ms"))
                    engine.setdefault("splash_request_latency", m)
                for ch in obj.get("choices", []):
                    dd = ch.get("delta") or {}
                    if ch.get("finish_reason"):
                        finish = ch.get("finish_reason")
                    piece = (dd.get("reasoning_content") or "") + (dd.get("content") or "")
                    if piece:
                        deltas.append(piece)
                        kinds.append("r" if dd.get("reasoning_content") else "c")
                        if ttft is None:
                            ttft = (time.monotonic() - t0) * 1000
                            first_delta = piece
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
    total = (time.monotonic() - t0) * 1000
    time.sleep(0.05)
    off1 = log_size()
    g1 = gpu_ns()
    c1 = cpu_ms()
    st1 = get_json("/status") if A.status_delta else None
    th1 = thermal_level()
    comp = usage.get("completion_tokens")
    text = "".join(deltas)
    rec = {
        "ok": err is None and comp is not None, "error": err,
        "ttft_ms": ttft, "total_ms": total,
        "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": comp,
        "decode_tps": (comp / ((total - ttft) / 1000)) if (ttft and comp and total > ttft) else None,
        "engine_decode_tps": engine.get("decode_tps"), "engine_ttft_ms": engine.get("ttft_ms"),
        "engine_prefill_tps": engine.get("prefill_tps"),
        "arm": A.arm, "mode": mode, "engine_name": A.engine, "url": URL,
        "prompt": pname, "iter": str(it), "seed": seed,
        "body": {k: v for k, v in body.items() if k != "messages"},
        "passage_sha1": PASSAGE_SHA1 if mode.startswith("ctx") or pname == "warmctx" else None,
        "wall_start": wall0, "finish": finish, "n_deltas": len(deltas), "first_delta": first_delta,
        "text": text, "deltas": deltas, "delta_kinds": "".join(kinds), "text_sha1": hashlib.sha1(text.encode()).hexdigest()[:12],
        "log": A.log or None, "log_off0": off0, "log_off1": off1,
        "status_delta": sdelta(st0, st1),
        "engine_gpu_ms": ((g1 - g0) / 1e6) if (g0 is not None and g1 is not None) else None,
        "engine_cpu_ms": (c1 - c0) if (c0 is not None and c1 is not None) else None,
        "loadavg1_start": load0[0], "loadavg_start": load0, "thermal_start": th0, "thermal_end": th1,
        "th_stats": engine if "total_ms" in engine or "spec_rounds" in engine else None,
        "splash_request_latency": engine.get("splash_request_latency"),
    }
    with open(out_path, "a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"  [{A.arm}] {mode:8s} {pname:6s}#{it} seed={seed} p={rec['prompt_tokens']} comp={comp} "
          f"fin={finish} ttft={ttft or 0:.0f}ms total={total:.0f}ms gpu={rec['engine_gpu_ms'] or 0:.0f}ms "
          f"load1={load0[0]:.2f} therm={th0}/{th1} sha={rec['text_sha1']}{' ERR ' + err if err else ''}", flush=True)
    return rec

WARM = A.out + ".warmup.jsonl"
GREEDY = {"temperature": 0.0}
SAMPLED = {"temperature": 0.6, "top_p": 0.95, "top_k": 20}
print(f"[{A.arm}] {A.engine} :{A.port} model={MODEL} pids={PIDS} passage={PASSAGE_SHA1}", flush=True)
measure("warmup", "warm", 0, "Say hi.", 32, GREEDY, None, WARM)
measure("warmup", "warmctx", 0, PASSAGE + "\n\nSay hi.", 32, GREEDY, None, WARM)
modes = A.modes.split(",")
if "greedy" in modes:
    for pname, p in BENCH:
        for i in range(1, A.iters + 1):
            measure("greedy", pname, i, p, A.max_tokens, GREEDY, None, A.out)
if "sampled" in modes:
    for pname, p in BENCH:
        for i, seed in enumerate(SEEDS[:A.iters], 1):
            measure("sampled", pname, i, p, A.max_tokens, SAMPLED, seed, A.out)
if "ctx1500" in modes:
    for pname, p in BENCH:
        for i in range(1, A.iters + 1):
            measure("ctx1500", pname, i, PASSAGE + "\n\n" + p, A.max_tokens, GREEDY, None, A.out)
if "ctxcold" in modes:
    for k, (pname, p) in enumerate(BENCH, 1):
        measure("ctxcold", pname, 1, f"Note {k}.\n" + PASSAGE + "\n\n" + p, A.max_tokens, GREEDY, None, A.out)
print(f"[{A.arm}] done", flush=True)
