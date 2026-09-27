#!/usr/bin/env bash
# bench-engines-port.sh — port-parametrized copy of scripts/bench-engines.sh
# (@44aed06). Same prompt suite, same SSE measure() (readline, TTFT = first
# content/reasoning delta, decode_tps = completion/(total-ttft)), same
# aggregation. Changes vs the original (diff against bench-engines.orig.sh):
#   BENCH_ENGINES="name:port ..."   engines to hit (was hardcoded splash:8000 thengine:8001)
#   BENCH_TEMP / BENCH_TOP_P / BENCH_TOP_K   explicit sampling params in the body
#                                   (original sent only temperature 0.6)
#   BENCH_OUT                       results history file (original: ~/.config/token-horizon/engine-bench.json)
#   BENCH_RUNS_JSONL                per-request records (text, timestamps, log offsets, /status deltas)
#   BENCH_LOG                       th-engine stderr log: byte offsets before/after each request
#   BENCH_STATUS_DELTA=1            GET /status before/after each request (Splash native counters)
#   BENCH_GPU_PIDS=pid,..           ioreg accumulatedGPUTime of the engine before/after each request
#   BENCH_ARM / BENCH_MODE          labels copied into the per-request records
#   BENCH_WARMUP=1                  one unrecorded warmup request per engine before the suite
# All extra probes run outside the timed window (before t0 / after the stream ends).

set -uo pipefail

OUT="${BENCH_OUT:-${XDG_CONFIG_HOME:-$HOME/.config}/token-horizon/engine-bench.json}"
ITERS="${BENCH_ITERS:-2}"
MAXTOK="${BENCH_MAX_TOKENS:-128}"
ENGINES="${BENCH_ENGINES:-splash:8000 thengine:8001}"
mkdir -p "$(dirname "$OUT")"

PROMPTS_FILE=$(mktemp)
cat > "$PROMPTS_FILE" <<'EOF'
short|Reply with exactly: hello world
code|Write a Python function that reverses a linked list. Include a docstring.
long|Summarise the key design constraints of the UNIX process model: file descriptors, fork/exec, signals, and pipes. Two sentences each.
EOF

measure() { # $1=url $2=model $3=prompt [$4=pname $5=iter] → prints one JSON object
  python3 - "$1" "$2" "$3" "$MAXTOK" "${4:-}" "${5:-}" <<'PYEOF'
import json, sys, time, urllib.request, os, hashlib

url, model, prompt, maxtok = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
pname, it = sys.argv[5], sys.argv[6]
req_body = {
    "model": model,
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": maxtok,
    "stream": True,
    "stream_options": {"include_usage": True},
    "temperature": 0.6,
}
# explicit sampling (orchestrator rule: T=0.6 / top_p 0.95 / top_k 20, or T=0)
if os.environ.get("BENCH_TEMP"):
    req_body["temperature"] = float(os.environ["BENCH_TEMP"])
if os.environ.get("BENCH_TOP_P"):
    req_body["top_p"] = float(os.environ["BENCH_TOP_P"])
if os.environ.get("BENCH_TOP_K"):
    req_body["top_k"] = int(os.environ["BENCH_TOP_K"])
if os.environ.get("BENCH_SEED_BASE") and it:
    pidx = {"short": 0, "code": 1, "long": 2}.get(pname, 9)
    req_body["seed"] = int(os.environ["BENCH_SEED_BASE"]) + 10 * pidx + int(it)
body = json.dumps(req_body).encode()

base = url.split("/v1/")[0]
log_path = os.environ.get("BENCH_LOG") or ""
def log_size():
    try:
        return os.path.getsize(log_path) if log_path else None
    except OSError:
        return None
def get_status():
    if os.environ.get("BENCH_STATUS_DELTA") != "1":
        return None
    try:
        with urllib.request.urlopen(base + "/status", timeout=10) as r:
            return json.load(r)
    except Exception:
        return None
def gpu_ns():
    pids = [int(x) for x in (os.environ.get("BENCH_GPU_PIDS") or "").split(",") if x]
    if not pids:
        return None
    try:
        sys.path.insert(0, os.environ.get("BENCH_DIR", "."))
        import gpuq
        snap = gpuq.snapshot()["pids"]
        return sum(snap.get(p, {}).get("gpu_ns", 0) for p in pids)
    except Exception:
        return None

def cpu_ms():
    pids = [x for x in (os.environ.get("BENCH_CPU_PIDS") or "").split(",") if x]
    if not pids:
        return None
    import subprocess
    tot = 0.0
    for p in pids:
        t = subprocess.run(["ps", "-o", "time=", "-p", p], capture_output=True, text=True).stdout.strip()
        if not t:
            continue
        parts = t.split(":")
        secs = float(parts[-1]) + 60 * float(parts[-2]) + (3600 * float(parts[-3]) if len(parts) > 2 else 0)
        tot += secs * 1000
    return tot

st0 = get_status()
c0 = cpu_ms()
load0 = os.getloadavg()[0]
g0 = gpu_ns()
off0 = log_size()
wall0 = time.time()
t0 = time.monotonic()
ttft = None
usage = {}
engine = {}
err = None
text = []
first_delta = None
n_deltas = 0
finish = None
try:
    req = urllib.request.Request(url, data=body,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        # readline() surfaces each SSE line as it lands; `for raw in r`
        # blocks until the 8KB buffer fills, inflating client-side TTFT
        while True:
            raw = r.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            if obj.get("usage"):
                usage = obj["usage"]
            if obj.get("th_stats"):
                engine = obj["th_stats"]
            # Splash puts its latency/throughput in the final chunk's metrics
            if obj.get("metrics"):
                m = obj["metrics"].get("request_latency") or {}
                engine.setdefault("decode_tps", m.get("stream_tokens_per_second"))
                engine.setdefault("ttft_ms", m.get("ttft_ms"))
                engine.setdefault("splash_request_latency", m)
            for ch in obj.get("choices", []):
                d = ch.get("delta") or {}
                if ch.get("finish_reason"):
                    finish = ch.get("finish_reason")
                piece = (d.get("reasoning_content") or "") + (d.get("content") or "")
                if piece:
                    n_deltas += 1
                    text.append(piece)
                # reasoning_content counts as generation — thinking models
                # stream reasoning before visible content
                if (d.get("content") or d.get("reasoning_content")) and ttft is None:
                    ttft = (time.monotonic() - t0) * 1000
                    first_delta = piece
except Exception as e:
    err = f"{type(e).__name__}: {e}"
total = (time.monotonic() - t0) * 1000
time.sleep(0.05)   # let the engine's last stderr line land before the offset read
off1 = log_size()
g1 = gpu_ns()
c1 = cpu_ms()
st1 = get_status()
comp = usage.get("completion_tokens")
decode_tps = None
if ttft and comp and total > ttft:
    decode_tps = comp / ((total - ttft) / 1000)

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

full = "".join(text)
rec = {
    "ok": err is None, "error": err,
    "ttft_ms": ttft, "total_ms": total,
    "prompt_tokens": usage.get("prompt_tokens"),
    "completion_tokens": comp,
    "decode_tps": decode_tps,
    "engine_decode_tps": engine.get("decode_tps"),
    "engine_ttft_ms": engine.get("ttft_ms"),
    "engine_prefill_tps": engine.get("prefill_tps"),
}
extra = dict(rec)
extra.update({
    "arm": os.environ.get("BENCH_ARM"), "mode": os.environ.get("BENCH_MODE"),
    "engine_name": os.environ.get("BENCH_ENGINE_NAME"), "url": url,
    "prompt": pname, "iter": it,
    "body": {k: v for k, v in req_body.items() if k != "messages"},
    "wall_start": wall0, "finish": finish, "n_deltas": n_deltas,
    "first_delta": first_delta, "text": full,
    "text_sha1": hashlib.sha1(full.encode()).hexdigest()[:12],
    "log": log_path or None, "log_off0": off0, "log_off1": off1,
    "status_delta": sdelta(st0, st1),
    "engine_gpu_ms": ((g1 - g0) / 1e6) if (g0 is not None and g1 is not None) else None,
    "engine_cpu_ms": (c1 - c0) if (c0 is not None and c1 is not None) else None,
    "loadavg1_start": load0,
    "th_stats": engine if "total_ms" in engine else None,
    "splash_request_latency": engine.get("splash_request_latency"),
})
jl = os.environ.get("BENCH_RUNS_JSONL")
if jl and pname != "warmup":
    with open(jl, "a") as f:
        f.write(json.dumps(extra) + "\n")
print(json.dumps(rec))
PYEOF
}

RESULTS_JSON=$(mktemp)
echo "{}" > "$RESULTS_JSON"
ran=0

for engine in $ENGINES; do
  name="${engine%%:*}"; port="${engine##*:}"
  [ "${BENCH_ONLY:-}" ] && [ "$BENCH_ONLY" != "$name" ] && continue
  status=$(curl -s --max-time 2 "http://127.0.0.1:$port/status" 2>/dev/null)
  [ -z "$status" ] && { echo "· $name :$port — not serving, skipping"; continue; }
  model=$(echo "$status" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('instance') or {}).get('model') or (d.get('model') if isinstance(d.get('model'),str) else '?'))" 2>/dev/null)
  echo "· $name :$port — $model  [temp=${BENCH_TEMP:-0.6} top_p=${BENCH_TOP_P:-} top_k=${BENCH_TOP_K:-}]"
  export BENCH_ENGINE_NAME="$name"

  if [ "${BENCH_WARMUP:-0}" = "1" ]; then
    w=$(measure "http://127.0.0.1:$port/v1/chat/completions" "$model" "Say hi." warmup 0)
    echo "    warmup: $(echo "$w" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if d['ok'] else d['error'], round(d.get('total_ms') or 0),'ms')")"
  fi

  RUNS_FILE=$(mktemp)
  while IFS='|' read -r pname prompt; do
    for i in $(seq 1 "$ITERS"); do
      r=$(measure "http://127.0.0.1:$port/v1/chat/completions" "$model" "$prompt" "$pname" "$i")
      ok=$(echo "$r" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])")
      if [ "$ok" = "True" ]; then
        echo "$r" >> "$RUNS_FILE"
        ttft=$(echo "$r" | python3 -c "import json,sys; print(round(json.load(sys.stdin)['ttft_ms'] or 0))")
        tps=$(echo "$r" | python3 -c "import json,sys; d=json.load(sys.stdin); print(round(d.get('engine_decode_tps') or d.get('decode_tps') or 0,1))")
        ctoks=$(echo "$r" | python3 -c "import json,sys; print(json.load(sys.stdin)['completion_tokens'])")
        echo "    $pname#$i: ttft=${ttft}ms decode=${tps}tok/s comp=${ctoks}"
      else
        echo '{"ok":false}' >> "$RUNS_FILE"
        echo "    $pname#$i: ERROR $(echo "$r" | python3 -c "import json,sys; print(json.load(sys.stdin)['error'])")"
      fi
    done
  done < "$PROMPTS_FILE"

  # aggregate into results json
  python3 - "$RESULTS_JSON" "$RUNS_FILE" "$name" "$model" <<'PYEOF'
import json, sys
res_path, runs_path, name, model = sys.argv[1:5]
res = json.load(open(res_path))
rows = [json.loads(l) for l in open(runs_path) if l.strip()]
ok = [r for r in rows if r["ok"]]
def avg(k):
    v = [r[k] for r in ok if r.get(k) is not None]
    return sum(v) / len(v) if v else None
# decode_tps prefers the engine's own report — fast engines finish inside
# one socket read so wall-clock delta timing can't measure them.
def dec(r):
    return r.get("engine_decode_tps") or r.get("decode_tps")
res[name] = {
    "model": model,
    "n": len(rows), "errors": len(rows) - len(ok),
    "ttft_ms": avg("ttft_ms"), "total_ms": avg("total_ms"),
    "decode_tps": (lambda v: sum(v)/len(v) if v else None)(
        [x for x in (dec(r) for r in ok) if x is not None]),
    "wall_decode_tps": avg("decode_tps"),
    "engine_ttft_ms": avg("engine_ttft_ms"),
    "engine_prefill_tps": avg("engine_prefill_tps"),
    "prompt_tokens": avg("prompt_tokens"),
    "completion_tokens": avg("completion_tokens"),
}
json.dump(res, open(res_path, "w"))
PYEOF
  rm -f "$RUNS_FILE"
  ran=1
done

[ "$ran" = "0" ] && { echo "no engines serving — start one via POST :8765/engine/serve"; rm -f "$PROMPTS_FILE" "$RESULTS_JSON"; exit 1; }

python3 - "$OUT" "$RESULTS_JSON" "$ITERS" "$MAXTOK" <<'PYEOF'
import json, sys, datetime, os
out_path, res_path, iters, maxtok = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
payload = {
    "ran_at": datetime.datetime.now().isoformat(timespec="seconds"),
    "suite": {"prompts": ["short", "code", "long"], "iters": iters, "max_tokens": maxtok,
              "temperature": os.environ.get("BENCH_TEMP"), "top_p": os.environ.get("BENCH_TOP_P"),
              "top_k": os.environ.get("BENCH_TOP_K"), "arm": os.environ.get("BENCH_ARM"),
              "mode": os.environ.get("BENCH_MODE")},
    "engines": json.load(open(res_path)),
    "note": "TTFT/decode measured client-side over SSE; token counts engine-reported. Models differ per engine — compare within-class, not as absolute parity.",
}
try:
    hist = json.load(open(out_path))
    if not (isinstance(hist, dict) and "runs" in hist):
        raise ValueError
except Exception:
    hist = {"runs": []}
hist["runs"].append(payload)
hist["runs"] = hist["runs"][-50:]
hist["latest"] = payload
json.dump(hist, open(out_path, "w"), indent=1)
print(f"wrote {out_path}")
PYEOF

rm -f "$PROMPTS_FILE" "$RESULTS_JSON"
