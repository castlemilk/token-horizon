#!/bin/bash
# session.sh OUTDIR [ARMS] — bench-quiet: one gpu-lock hold, fresh server per arm, ABBA across engines:
#   integ1 main1 splash1 splash2 main2 integ2   (th arms on private ports 8030+N; Splash only on a free :8000)
# Run as:  $P/bin/gpu-lock -- bash session.sh OUTDIR
set -u
Q=/Users/benebsworth/projects/token-horizon/.worktrees/bench-main/.bench-quiet
OUT=${1:?outdir}; ARMS=${2:-"integ1 main1 splash1 splash2 main2 integ2"}
mkdir -p "$OUT"
TGT="$HOME/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots/10c35caafbb80f7dc6a7a432cdd11af10a6d4818"
DRAFT="$HOME/Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash/draft"
INTEG_WT=/Users/benebsworth/projects/token-horizon/.worktrees/report-integration-sim
MAIN_WT=/Users/benebsworth/projects/token-horizon/.worktrees/bench-main
RUNS=$OUT/runs.jsonl
GQ="python3 $Q/gpuq.py"
SRV_PID=; SPLASH_PID=; SRV_PIDS=

log() { echo "[$(date +%T)] $*"; }

envsnap() { # $1 label
  python3 - "$1" <<'PY' >> "$OUT/env.jsonl"
import json, subprocess, sys, time, os, re
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
t = sh("top -l 2 -s 1 -n 0 | grep 'CPU usage' | tail -1")
m = re.search(r"([\d.]+)% idle", t)
print(json.dumps({"label": sys.argv[1], "at": time.strftime("%H:%M:%S"), "loadavg": os.getloadavg(),
                  "cpu_idle_pct": float(m.group(1)) if m else None, "cpu_line": t,
                  "mem": sh("memory_pressure | tail -1"), "swap": sh("sysctl -n vm.swapusage"),
                  "therm": sh("pmset -g therm | grep -v '^$' | tail -2"),
                  "thermal_pressure": sh("notifyutil -g com.apple.system.thermalpressurelevel | awk '{print $2}'"),
                  "top": sh("ps -axo pid,%cpu,rss,comm -r | head -7 | tail -6").splitlines()}))
PY
  tail -1 "$OUT/env.jsonl" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"    env {d['label']}: load {d['loadavg'][0]:.2f}/{d['loadavg'][1]:.2f}/{d['loadavg'][2]:.2f} cpu-idle {d['cpu_idle_pct']}% thermal-pressure {d.get('thermal_pressure')} {d['mem']}\")"
}

waitcpu() { # wait (<=180 s) until whole-machine CPU idle >= 85% over a 1 s top sample
  local t0=$(date +%s) idle
  while :; do
    idle=$(top -l 2 -s 1 -n 0 | grep 'CPU usage' | tail -1 | sed -E 's/.* ([0-9.]+)% idle.*/\1/')
    if python3 -c "import sys; sys.exit(0 if float('$idle') >= 85 else 1)"; then break; fi
    [ $(( $(date +%s) - t0 )) -gt 180 ] && { log "cpu not quiet after 180s (idle ${idle}%), proceeding"; break; }
    sleep 4
  done
  echo "{\"label\":\"$1\",\"at\":\"$(date +%T)\",\"cpu_idle_pct\":$idle,\"waited_s\":$(( $(date +%s) - t0 )),\"loadavg\":\"$(sysctl -n vm.loadavg)\"}" >> "$OUT/quiet.jsonl"
  log "cpu idle ${idle}% (waited $(( $(date +%s) - t0 ))s), load $(sysctl -n vm.loadavg)"
}

THERM_FIRST=1
waittherm() { # wait (GPU idle under our lock) for thermal pressure level 0 (nominal): <= 420 s before the first arm, <= 150 s later
  local t0=$(date +%s) lv lim=${BQ_THERM_WAIT:-150}
  [ "$THERM_FIRST" = 1 ] && lim=${BQ_THERM_WAIT_FIRST:-420}; THERM_FIRST=0
  while :; do
    lv=$(notifyutil -g com.apple.system.thermalpressurelevel | awk '{print $2}')
    [ "$lv" = "0" ] && break
    [ $(( $(date +%s) - t0 )) -gt $lim ] && { log "thermal pressure still $lv after ${lim}s, proceeding"; break; }
    sleep 5
  done
  echo "{\"label\":\"$1\",\"at\":\"$(date +%T)\",\"thermal_level\":$lv,\"therm_waited_s\":$(( $(date +%s) - t0 ))}" >> "$OUT/quiet.jsonl"
  log "thermal pressure $lv (waited $(( $(date +%s) - t0 ))s)"
}

descendants() { local p=$1 c; for c in $(pgrep -P "$p"); do echo "$c"; descendants "$c"; done; }

start_th() { # label bin wt port
  local label=$1 bin=$2 wt=$3 port=$4
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then log "port $port busy — abort"; return 1; fi
  log "[$label] bin=$bin sha256=$(shasum -a 256 "$bin" | cut -c1-16) commit=$(git -C "$wt" rev-parse --short HEAD) dirty_tracked=$(git -C "$wt" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  cd "$wt/engine" || return 1
  env -u TH_BATCH TH_DEBUG_TIMING=1 nohup "$bin" serve --model "$TGT" --draft "$DRAFT" --port $port > "$OUT/$label.server.log" 2>&1 &
  SRV_PID=$!; SRV_PIDS=$SRV_PID
  local i
  for i in $(seq 1 300); do
    sleep 1
    curl -s -m 2 127.0.0.1:$port/status > "$OUT/$label.status.json" 2>/dev/null && [ -s "$OUT/$label.status.json" ] && { log "[$label] up after ${i}s pid=$SRV_PID"; return 0; }
    kill -0 $SRV_PID 2>/dev/null || { log "[$label] server died"; tail -20 "$OUT/$label.server.log"; SRV_PID=; return 1; }
  done
  log "[$label] not up after 300s"; return 1
}

stop_th() {
  [ -n "$SRV_PID" ] || return 0
  kill -TERM $SRV_PID 2>/dev/null
  local j; for j in $(seq 1 20); do kill -0 $SRV_PID 2>/dev/null || break; sleep 1; done
  kill -KILL $SRV_PID 2>/dev/null
  wait $SRV_PID 2>/dev/null
  log "stopped th pid $SRV_PID"; SRV_PID=; SRV_PIDS=
}

start_splash() { # label
  local label=$1 attempt i r
  if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then log ":8000 busy (not mine) — skipping Splash arm"; return 1; fi
  for attempt in 1 2 3; do
    log "[$label] starting splash (attempt $attempt); $(memory_pressure | tail -1)"
    cd "$OUT" || return 1
    nohup splash serve --model incoai/Qwen3.8-27B-Splash >> "$OUT/$label.splash.log" 2>&1 &
    SPLASH_PID=$!
    r=
    for i in $(seq 1 900); do
      sleep 1
      r=$(curl -s -m 2 127.0.0.1:8000/status 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('ready'))" 2>/dev/null)
      [ "$r" = "True" ] && break
      kill -0 $SPLASH_PID 2>/dev/null || { log "[$label] splash exited"; tail -4 "$OUT/$label.splash.log"; break; }
    done
    if [ "$r" = "True" ]; then
      SRV_PIDS=$( (echo $SPLASH_PID; descendants $SPLASH_PID; lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null) | sort -un | tr '\n' ',' | sed 's/,$//')
      log "[$label] splash ready after ${i}s pid=$SPLASH_PID pids=$SRV_PIDS"
      for p in ${SRV_PIDS//,/ }; do echo "    pid $p: $(ps -o command= -p $p | cut -c1-140)"; done
      curl -s -m 5 127.0.0.1:8000/status > "$OUT/$label.status.json"
      return 0
    fi
    stop_splash; sleep 20
  done
  return 1
}

stop_splash() {
  [ -n "$SPLASH_PID" ] || return 0
  local kids="$(descendants $SPLASH_PID | tr '\n' ' ')" i p
  kill -INT $SPLASH_PID 2>/dev/null
  for i in $(seq 1 30); do kill -0 $SPLASH_PID 2>/dev/null || break; sleep 1; done
  kill -0 $SPLASH_PID 2>/dev/null && kill -TERM $SPLASH_PID
  sleep 2
  for p in ${SRV_PIDS//,/ } $kids; do kill -0 $p 2>/dev/null && { log "leftover $p: $(ps -o command= -p $p | cut -c1-80)"; kill -TERM $p; }; done
  sleep 2
  for p in ${SRV_PIDS//,/ } $kids; do kill -0 $p 2>/dev/null && kill -KILL $p; done
  wait $SPLASH_PID 2>/dev/null
  log "stopped splash pid $SPLASH_PID (+ $kids)"; SPLASH_PID=; SRV_PIDS=
}

TOP_PID=
THERM_PID=; FREQ_PID=
cleanup() { stop_th; stop_splash; [ -n "$TOP_PID" ] && kill $TOP_PID 2>/dev/null; TOP_PID=; [ -n "$THERM_PID" ] && kill $THERM_PID 2>/dev/null; THERM_PID=; [ -n "$FREQ_PID" ] && kill $FREQ_PID 2>/dev/null; FREQ_PID=; }
trap cleanup EXIT
trap 'log "signal — cleaning up"; cleanup; exit 130' INT TERM

arm() { # label
  local label=$1 kind port bin wt ok=0
  case $label in
    integ*) kind=th; bin=$INTEG_WT/engine/target/release/th-engine; wt=$INTEG_WT ;;
    main*)  kind=th; bin=$MAIN_WT/engine/target/release/th-engine;  wt=$MAIN_WT ;;
    splash*) kind=splash ;;
  esac
  log "=== ARM $label ($kind)"
  envsnap "$label-pre"
  waittherm "$label"
  waitcpu "$label"
  $GQ waitquiet 60 3 90 | sed "s/^/{\"arm\":\"$label\",\"gpu\":/; s/$/}/" | tee -a "$OUT/quiet.jsonl" | sed 's/^/    gpu-quiet: /'
  $GQ snap "$OUT/snap-$label-0.json"
  if [ $kind = th ]; then
    port=; for c in 8051 8052 8053 8054 8055 8056 8057 8058 8059; do lsof -nP -iTCP:$c -sTCP:LISTEN >/dev/null 2>&1 || { port=$c; break; }; done
    [ -n "$port" ] || { log "no free port in 8051-8059"; return 1; }
    start_th $label "$bin" "$wt" $port && ok=1
    [ $ok = 1 ] && python3 $Q/bq_client.py --port $port --engine th-${label%[0-9]} --arm $label --out "$RUNS" \
        --log "$OUT/$label.server.log" --pids "$SRV_PIDS" ${BQ_CLIENT_ARGS:-}
    [ $ok = 1 ] && curl -s -m 5 127.0.0.1:$port/status > "$OUT/$label.status_after.json" 2>/dev/null
    local excl=$SRV_PIDS
    stop_th
  else
    start_splash $label && ok=1
    [ $ok = 1 ] && python3 $Q/bq_client.py --port 8000 --engine splash --arm $label --out "$RUNS" \
        --status-delta --pids "$SRV_PIDS" ${BQ_CLIENT_ARGS:-}
    [ $ok = 1 ] && curl -s -m 5 127.0.0.1:8000/status > "$OUT/$label.status_after.json" 2>/dev/null
    local excl=$SRV_PIDS
    stop_splash
  fi
  $GQ snap "$OUT/snap-$label-1.json"
  $GQ delta "$OUT/snap-$label-0.json" "$OUT/snap-$label-1.json" --exclude "$excl" | sed "s/^/{\"arm\":\"$label\",\"contention\":/; s/$/}/" >> "$OUT/contention.jsonl"
  tail -1 "$OUT/contention.jsonl" | cut -c1-300 | sed 's/^/    contention: /'
  envsnap "$label-post"
  sleep 3
}

top -l 0 -s 3 -n 8 -o cpu -stats pid,command,cpu > "$OUT/top.log" 2>&1 &
TOP_PID=$!
# thermal pressure sampler (0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping) every 2 s
( while :; do echo "$(date +%s) $(notifyutil -g com.apple.system.thermalpressurelevel | awk '{print $2}')"; sleep 2; done ) > "$OUT/thermal.log" 2>&1 &
THERM_PID=$!
# GPU P-state residency sampler (IOReport, no root): one JSON line per 2 s window
python3 -u "$Q/gpufreq.py" 2 --loop 100000 > "$OUT/gpufreq.jsonl" 2>&1 &
FREQ_PID=$!
log "=== session start; arms: $ARMS; $(sysctl -n vm.loadavg); top sampler pid $TOP_PID"
log "listeners before: $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $1":"$2":"$9}' | grep -E ':(80[0-9][0-9])$' | tr '\n' ' ')"
for a in $ARMS; do arm $a; done
log "=== session end; $(sysctl -n vm.loadavg)"
log "listeners after: $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $1":"$2":"$9}' | grep -E ':(80[0-9][0-9])$' | tr '\n' ' ')"
