#!/usr/bin/env bash
# bench-engines.sh — side-by-side benchmark of the supervised engines.
#
# Runs the same prompt suite against every engine currently serving:
#   splash    → http://127.0.0.1:8000  (supervised; spawn via /engine/serve)
#   thengine  → http://127.0.0.1:8001  (engine/target/release/th-engine)
#   mlx       → http://127.0.0.1:8002  (mlx-lm / mlx-vlm; mlx-vlm's /metrics
#                                      supplies engine-side decode tok/s)
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
#   BENCH_COPY_MAX_TOKENS=384 completion cap for the copy arm (output
#                        overlaps the prompt, so it wants room to run)
#   BENCH_ONLY=splash    limit to one engine
#
# Prompt classes: short/code/long are chat-shaped; `copy` is the
# reproduction arm — the answer repeats the prompt, which is where
# prompt-lookup speculation and the prefix cache pay off (HyperQwen-style
# "381 vs 127" split). Rows carry th-engine's spec_rounds/spec_accepted/
# cached_tokens when the engine reports them, so tokens/round and
# prefix-cache reuse land in the per-engine `classes` aggregates.

set -uo pipefail

OUT="${XDG_CONFIG_HOME:-$HOME/.config}/token-horizon/engine-bench.json"
ITERS="${BENCH_ITERS:-2}"
MAXTOK="${BENCH_MAX_TOKENS:-128}"
COPY_MAXTOK="${BENCH_COPY_MAX_TOKENS:-384}"
mkdir -p "$(dirname "$OUT")"

# Load gate — playbook §3 (thermal/load gates with redo rules). Numbers
# taken on a busy or throttled machine cannot be set beside quiet ones.
# Warn by default; BENCH_LOAD_GATE=strict refuses to measure.
load_gate() {
  local cores load1 speed fail=0
  cores=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
  load1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
  speed=$(pmset -g therm 2>/dev/null | awk '/CPU_Speed_Limit/{gsub(/%/,""); print $NF}')
  if [ -n "$speed" ] && [ "$speed" -lt 100 ] 2>/dev/null; then
    echo "⚠ load gate: CPU throttled (CPU_Speed_Limit=${speed}%) — numbers will read low"
    fail=1
  fi
  if [ -n "$load1" ] && [ "$(python3 -c "print($load1 > $cores/2)")" = "True" ]; then
    echo "⚠ load gate: 1-min loadavg ${load1} on ${cores} cores (threshold $((cores / 2))) — machine busy"
    fail=1
  fi
  if [ "$fail" = 1 ]; then
    if [ "${BENCH_LOAD_GATE:-warn}" = "strict" ]; then
      echo "  BENCH_LOAD_GATE=strict — refusing to measure under load"; exit 1
    fi
    echo "  (continuing — set BENCH_LOAD_GATE=strict to refuse; label any numbers as under-load)"
  fi
}
load_gate

PROMPTS_FILE=$(mktemp)
cat > "$PROMPTS_FILE" <<'EOF'
short|Reply with exactly: hello world
code|Write a Python function that reverses a linked list. Include a docstring.
long|Summarise the key design constraints of the UNIX process model: file descriptors, fork/exec, signals, and pipes. Two sentences each.
EOF
# copy arm: a deterministic document the model must reproduce verbatim.
# Single line — PROMPTS_FILE is line-oriented (IFS='|' read), and output
# that overlaps a long input is what exercises lookup speculation and the
# prefix cache.
DOC=$(python3 - <<'PYEOF'
lines = []
for i in range(1, 41):
    lines.append(f"REQ-{i:03d}: module=auth_{(i % 7) + 1} status={'ok' if i % 3 else 'degraded'} latency={(i * 37) % 900}ms owner=team{(i % 5) + 1}")
print("SYSTEM INCIDENT LOG (reproduce exactly, every entry, no commentary): " + " | ".join(lines))
PYEOF
)
printf 'copy|%s\n' "$DOC" >> "$PROMPTS_FILE"

measure() { # $1=url $2=model $3=prompt $4=maxtok [$5=metrics url] [$6=class] → prints one JSON object
  python3 - "$1" "$2" "$3" "$4" "${5:-}" "${6:-chat}" <<'PYEOF'
import json, sys, time, urllib.request

url, model, prompt, maxtok = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
metrics_url, klass = sys.argv[5], sys.argv[6]
wall0 = time.time()
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
            for ch in obj.get("choices", []):
                d = ch.get("delta") or {}
                # reasoning_content counts as generation — thinking models
                # stream reasoning before visible content
                if (d.get("content") or d.get("reasoning_content")) and ttft is None:
                    ttft = (time.monotonic() - t0) * 1000
except Exception as e:
    err = f"{type(e).__name__}: {e}"
total = (time.monotonic() - t0) * 1000
# mlx-vlm reports each completed request on /metrics; take it only if it is
# this request's summary (stamped after we started).
if metrics_url and err is None:
    try:
        with urllib.request.urlopen(metrics_url, timeout=5) as r:
            latest = json.load(r).get("latest") or {}
        if (latest.get("timestamp_unix") or 0) >= wall0:
            engine.setdefault("decode_tps", latest.get("decode_tok_s"))
            engine.setdefault("prefill_tps", latest.get("prefill_tok_s"))
            if latest.get("ttft_s") is not None:
                engine.setdefault("ttft_ms", latest["ttft_s"] * 1000)
    except Exception:
        pass
comp = usage.get("completion_tokens")
decode_tps = None
if ttft and comp and total > ttft:
    decode_tps = comp / ((total - ttft) / 1000)
print(json.dumps({
    "ok": err is None, "error": err,
    "class": klass,
    "ttft_ms": ttft, "total_ms": total,
    "prompt_tokens": usage.get("prompt_tokens"),
    "completion_tokens": comp,
    "decode_tps": decode_tps,
    "engine_decode_tps": engine.get("decode_tps"),
    "engine_ttft_ms": engine.get("ttft_ms"),
    "engine_prefill_tps": engine.get("prefill_tps"),
    "spec_rounds": engine.get("spec_rounds"),
    "spec_accepted": engine.get("spec_accepted"),
    "cached_tokens": engine.get("cached_tokens"),
}))
PYEOF
}

RESULTS_JSON=$(mktemp)
echo "{}" > "$RESULTS_JSON"
ran=0

for engine in splash:8000 thengine:8001 mlx:8002; do
  name="${engine%%:*}"; port="${engine##*:}"
  [ "${BENCH_ONLY:-}" ] && [ "$BENCH_ONLY" != "$name" ] && continue
  metrics=""
  if [ "$name" = "mlx" ]; then
    # No /status here. mlx-vlm flags the served entry `loaded` among every
    # cached checkpoint; mlx-lm can't say, so ask the app's supervisor. Never
    # guess — a wrong id makes the server load a second model.
    status=$(curl -s --max-time 2 "http://127.0.0.1:$port/v1/models" 2>/dev/null)
    [ -z "$status" ] && { echo "· $name :$port — not serving, skipping"; continue; }
    model=$(echo "$status" | python3 -c '
import json, sys
print(next((m["id"] for m in json.load(sys.stdin).get("data") or [] if m.get("loaded") is True), ""))' 2>/dev/null)
    [ -z "$model" ] && model=$(curl -s --max-time 2 "http://127.0.0.1:8889/engine" 2>/dev/null | python3 -c '
import json, sys
print(json.load(sys.stdin)["backends"]["mlx"]["supervisor"].get("model") or "")' 2>/dev/null)
    [ -z "$model" ] && { echo "· $name :$port — no served model reported, skipping"; continue; }
    metrics="http://127.0.0.1:$port/metrics"
  else
    status=$(curl -s --max-time 2 "http://127.0.0.1:$port/status" 2>/dev/null)
    [ -z "$status" ] && { echo "· $name :$port — not serving, skipping"; continue; }
    model=$(echo "$status" | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('instance') or {}).get('model') or (d.get('model') if isinstance(d.get('model'),str) else '?'))" 2>/dev/null)
  fi
  echo "· $name :$port — $model"

  RUNS_FILE=$(mktemp)
  while IFS='|' read -r pname prompt; do
    budget="$MAXTOK"; [ "$pname" = "copy" ] && budget="$COPY_MAXTOK"
    for i in $(seq 1 "$ITERS"); do
      r=$(measure "http://127.0.0.1:$port/v1/chat/completions" "$model" "$prompt" "$budget" "$metrics" "$pname")
      ok=$(echo "$r" | python3 -c "import json,sys; print(json.load(sys.stdin)['ok'])")
      if [ "$ok" = "True" ]; then
        echo "$r" >> "$RUNS_FILE"
        ttft=$(echo "$r" | python3 -c "import json,sys; print(round(json.load(sys.stdin)['ttft_ms'] or 0))")
        tps=$(echo "$r" | python3 -c "import json,sys; d=json.load(sys.stdin); print(round(d.get('engine_decode_tps') or d.get('decode_tps') or 0,1))")
        tpr=$(echo "$r" | python3 -c "import json,sys; d=json.load(sys.stdin); r,a=d.get('spec_rounds') or 0, d.get('spec_accepted') or 0; print(f'{a/r:.1f}' if r else '-')")
        echo "    $pname#$i: ttft=${ttft}ms decode=${tps}tok/s tok/round=${tpr}"
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
# Per-class aggregates (additive): chat vs the copy/reproduction arm —
# spec decode and the prefix cache pay off per class, not on average.
classes = {}
for r in ok:
    classes.setdefault(r.get("class") or "chat", []).append(r)
def cavg(rs, k):
    v = [r[k] for r in rs if r.get(k) is not None]
    return sum(v) / len(v) if v else None
res[name]["classes"] = {
    cls: {
        "n": len(rs),
        "decode_tps": (lambda v: sum(v)/len(v) if v else None)(
            [x for x in (dec(r) for r in rs) if x is not None]),
        "ttft_ms": cavg(rs, "ttft_ms"),
        "tokens_per_round": (
            (sum((r.get("spec_accepted") or 0) for r in rs) /
             sum((r.get("spec_rounds") or 0) for r in rs))
            if sum((r.get("spec_rounds") or 0) for r in rs) else None),
        "cached_tokens": cavg(rs, "cached_tokens"),
        "prompt_tokens": cavg(rs, "prompt_tokens"),
        "completion_tokens": cavg(rs, "completion_tokens"),
    }
    for cls, rs in sorted(classes.items())
}
json.dump(res, open(res_path, "w"))
PYEOF
  rm -f "$RUNS_FILE"
  ran=1
done

[ "$ran" = "0" ] && { echo "no engines serving — start one via POST :8889/engine/serve"; rm -f "$PROMPTS_FILE" "$RESULTS_JSON"; exit 1; }

python3 - "$OUT" "$RESULTS_JSON" "$ITERS" "$MAXTOK" "$COPY_MAXTOK" <<'PYEOF'
import json, sys, datetime
out_path, res_path, iters, maxtok = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
payload = {
    "ran_at": datetime.datetime.now().isoformat(timespec="seconds"),
    "suite": {"prompts": ["short", "code", "long", "copy"], "iters": iters,
              "max_tokens": maxtok,
              "copy_max_tokens": int(sys.argv[5]) if len(sys.argv) > 5 else None},
    "engines": json.load(open(res_path)),
    "note": "TTFT/decode measured client-side over SSE; token counts engine-reported. Models differ per engine — compare within-class, not as absolute parity. `copy` is the reproduction arm: output repeats the prompt, where prompt-lookup speculation and the prefix cache pay off (spec_rounds/spec_accepted/cached_tokens are th-engine-reported).",
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
