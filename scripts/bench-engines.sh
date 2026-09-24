#!/usr/bin/env bash
# bench-engines.sh — side-by-side benchmark of the supervised engines.
#
# Runs the same prompt suite against every engine currently serving:
#   splash    → http://127.0.0.1:8000  (supervised; spawn via /engine/serve)
#   thengine  → http://127.0.0.1:8001  (engine/target/release/th-engine)
#
# Metrics are measured client-side through the SSE stream so both engines
# are scored identically: TTFT = time to first content delta; decode_tps =
# completion_tokens / (total − ttft) — a wall-clock figure, since deltas
# may arrive batched in one TCP read and per-delta timing is meaningless.
# Engine-reported th_stats are recorded alongside when present.
#
# Results append to ~/.config/token-horizon/engine-bench.json (the app's
# GET /engine/bench and the ENGINE tab read it back).
#
# Env:
#   BENCH_ITERS=2        iterations per prompt
#   BENCH_MAX_TOKENS=128 completion cap
#   BENCH_ONLY=splash    limit to one engine

set -uo pipefail

OUT="${XDG_CONFIG_HOME:-$HOME/.config}/token-horizon/engine-bench.json"
ITERS="${BENCH_ITERS:-2}"
MAXTOK="${BENCH_MAX_TOKENS:-128}"
mkdir -p "$(dirname "$OUT")"

PROMPTS_FILE=$(mktemp)
cat > "$PROMPTS_FILE" <<'EOF'
short|Reply with exactly: hello world
code|Write a Python function that reverses a linked list. Include a docstring.
long|Summarise the key design constraints of the UNIX process model: file descriptors, fork/exec, signals, and pipes. Two sentences each.
EOF

measure() { # $1=url $2=model $3=prompt → prints one JSON object
  python3 - "$1" "$2" "$3" "$MAXTOK" <<'PYEOF'
import json, sys, time, urllib.request

url, model, prompt, maxtok = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
body = json.dumps({
    "model": model,
    "messages": [{"role": "user", "content": prompt}],
    "max_tokens": maxtok,
    "stream": True,
    "stream_options": {"include_usage": True},
    "temperature": 0.6,
}).encode()

t0 = time.monotonic()
ttft = None
usage = {}
engine = {}
err = None
try:
    req = urllib.request.Request(url, data=body,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        for raw in r:
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
            for ch in obj.get("choices", []):
                d = ch.get("delta") or {}
                # reasoning_content counts as generation — thinking models
                # stream reasoning before visible content
                if (d.get("content") or d.get("reasoning_content")) and ttft is None:
                    ttft = (time.monotonic() - t0) * 1000
except Exception as e:
    err = f"{type(e).__name__}: {e}"
total = (time.monotonic() - t0) * 1000
comp = usage.get("completion_tokens")
decode_tps = None
if ttft and comp and total > ttft:
    decode_tps = comp / ((total - ttft) / 1000)
print(json.dumps({
    "ok": err is None, "error": err,
    "ttft_ms": ttft, "total_ms": total,
    "prompt_tokens": usage.get("prompt_tokens"),
    "completion_tokens": comp,
    "decode_tps": decode_tps,
    "engine_decode_tps": engine.get("decode_tps"),
    "engine_ttft_ms": engine.get("ttft_ms"),
    "engine_prefill_tps": engine.get("prefill_tps"),
}))
PYEOF
}

RESULTS_JSON=$(mktemp)
echo "{}" > "$RESULTS_JSON"
ran=0

for engine in splash:8000 thengine:8001; do
  name="${engine%%:*}"; port="${engine##*:}"
  [ "${BENCH_ONLY:-}" ] && [ "$BENCH_ONLY" != "$name" ] && continue
  status=$(curl -s --max-time 2 "http://127.0.0.1:$port/status" 2>/dev/null)
  [ -z "$status" ] && { echo "· $name :$port — not serving, skipping"; continue; }
  model=$(echo "$status" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('instance') or {}).get('model') or (d.get('model') if isinstance(d.get('model'),str) else '?'))" 2>/dev/null)
  echo "· $name :$port — $model"

  RUNS_FILE=$(mktemp)
  while IFS='|' read -r pname prompt; do
    for i in $(seq 1 "$ITERS"); do
      r=$(measure "http://127.0.0.1:$port/v1/chat/completions" "$model" "$prompt")
      ok=$(echo "$r" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])")
      if [ "$ok" = "True" ]; then
        echo "$r" >> "$RUNS_FILE"
        ttft=$(echo "$r" | python3 -c "import json,sys; print(round(json.load(sys.stdin)['ttft_ms'] or 0))")
        tps=$(echo "$r" | python3 -c "import json,sys; d=json.load(sys.stdin); print(round(d.get('engine_decode_tps') or d.get('decode_tps') or 0,1))")
        echo "    $pname#$i: ttft=${ttft}ms decode=${tps}tok/s"
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
import json, sys, datetime
out_path, res_path, iters, maxtok = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
payload = {
    "ran_at": datetime.datetime.now().isoformat(timespec="seconds"),
    "suite": {"prompts": ["short", "code", "long"], "iters": iters, "max_tokens": maxtok},
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
hist["runs"] = hist["runs"][-20:]
hist["latest"] = payload
json.dump(hist, open(out_path, "w"), indent=1)
print(f"wrote {out_path}")
PYEOF

rm -f "$PROMPTS_FILE" "$RESULTS_JSON"
