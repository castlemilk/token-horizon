#!/bin/bash
# fin4d.sh OUTDIR — fin4c.sh + F_THERM_OK (default 1): the arm gate and the per-request thermal gates accept a pressure
#   level <= F_THERM_OK (external CPU heat held the SoC at level 1 all evening, so "wait for 0" only burned the caps);
#   our own level-2 heat after cold prefills is still waited out.
# fin4c.sh OUTDIR — fin4b.sh + CPU-aware arm gate (tier 2 also needs whole-machine CPU idle >= F_GATE_CPU_IDLE %%,
#   sampled by top) and, in block L only, a per-request CPU-idle wait (F_REQ_CPU_IDLE, client --cpu-idle-min) before
#   gated requests. Block S client protocol unchanged.
# fin4b.sh OUTDIR — fin4.sh continuation (20:40 restart, same client protocol): per-block redo policy
#   (F_ARM_TRIES_S / F_ARM_TRIES_L; F_ARM_THERM_FRAC_S / _L = fraction of requests at thermal >= 2 that makes an arm
#   dirty — workload-induced heat is not fixed by a redo, so the default here is 1.0 = redo only on errors / load),
#   block-L per-request thermal gates F_TTFT_GATE_MAX / F_THERM_GATE_MAX (default 240 s: 2 -> 0 takes ~165 s), and
#   old arms run ctx8k with F_OLD_ITERS8K iterations (default 1: every old ctx8k request is a cold 8k prefill).
# fin4.sh OUTDIR — integration-4 final A/B, ONE gpu-lock hold ($P/bin/gpu-lock -- bash fin4.sh OUT).
#   i4     = report/integration-4 c2c1532   $W/bin/th-engine-i4-c2c1532   (engine name th-new)
#   base   = main e452a7b (integration-3)   $W/bin/th-engine-base-e452a7b (th-base, sha256 eb3497fb...)
#   old    = old main 521c6e0 (integ.-2)    $W/bin/th-engine-old-521c6e0  (th-old,  sha256 66e99644...)
#   splash = Splash 1.0 (brew) on :8000, only if :8000 is free; SIGINT-stopped after its arm
# Block S (palindrome): i4_1 base_2 splash_3 old_4 old_5 splash_6 base_7 i4_8 — greedy, sampled, ctx1500 (warm 1.4k
#   prefix: the warm-up primes the passage), ctxcold (unique nonce per request: 9 cold ~1.45k prefills per arm).
# Block L (palindrome): i4_9 old_10 splash_11 base_12 base_13 splash_14 old_15 i4_16 — ttft (spec_t4: cold 1.45k x3,
#   1.4k exact repeat x2, other question after the 1.4k doc, cold 7.9k x3, 8k exact repeat, other question after the 8k
#   doc, multi-turn turns 1-3; max_tokens 16; every request first waits for thermal 0 <= 120 s + 1 s idle), then ctx8k
#   (8k passage + bench prompt, 3 x 3, T=0, 128 tokens; each request waits for thermal 0 <= 240 s). Warm-up "Say hi." only.
# th arms: fresh server per arm on the private port (env -u TH_BATCH TH_DEBUG_TIMING=1 serve --draft); one server at a
#   time, Splash never concurrent with a th server. fpmon: phys_footprint of th + Splash processes every 0.25 s
#   (th guard 64 GB).
# Per-arm gate (checked last, right before the server starts): tier 1 = thermal 0 AND load1 < F_LOAD_MAX held 30 s
#   within F_GATE_WAIT (first arm F_GATE_WAIT_FIRST) -> "pass"; else tier 2 = thermal 0 AND load1 < F_LOAD_MAX2 held
#   30 s within F_GATE_WAIT2 -> "pass2"; else thermal 0 held (<= F_THERM_WAIT) -> "soft". Every arm runs; conditions
#   are recorded per request (load1, thermal) and per arm (GPU contention from other processes).
# Redo after an arm (<= F_ARM_TRIES attempts): any failed request, > 10% of requests at thermal >= 2, > F_ARM_BAD_FRAC
#   of requests starting at load1 >= F_ARM_LOAD, or any at >= F_ARM_LOAD_MAX. If every attempt is dirty the cleanest
#   is kept and flagged in attempts.jsonl.
set -u
P=/Users/benebsworth/projects/token-horizon/.worktrees/_phaseC
W=$P/work/integration-4
Q=$W/bench
OUT=${1:?outdir}
PORT=${F_PORT:-8055}
QLOAD=${F_LOAD_MAX:-12.0}; QLOAD2=${F_LOAD_MAX2:-20.0}; QHOLD=${F_HOLD_S:-30}
GATE_WAIT_FIRST=${F_GATE_WAIT_FIRST:-600}; GATE_WAIT=${F_GATE_WAIT:-180}; GATE_WAIT2=${F_GATE_WAIT2:-180}; THERM_WAIT=${F_THERM_WAIT:-600}; CPU_WAIT=${F_CPU_WAIT:-20}
ARM_TRIES=${F_ARM_TRIES:-2}; ARM_LOAD=${F_ARM_LOAD:-30.0}; ARM_LOAD_MAX=${F_ARM_LOAD_MAX:-90.0}; ARM_BAD_FRAC=${F_ARM_BAD_FRAC:-0.5}
ORDER_S=${F_ORDER_S:-"i4_1 base_2 splash_3 old_4 old_5 splash_6 base_7 i4_8"}
ORDER_L=${F_ORDER_L:-"i4_9 old_10 splash_11 base_12 base_13 splash_14 old_15 i4_16"}
MODES_S=${F_MODES_S:-greedy,sampled,ctx1500,ctxcold}; MODES_L=${F_MODES_L:-ttft,ctx8k}
BLOCKS=${F_BLOCKS:-"S L"}
THERM_GATE_MAX=${F_THERM_GATE_MAX:-240}; TTFT_GATE_MAX=${F_TTFT_GATE_MAX:-240}; OLD_ITERS8K=${F_OLD_ITERS8K:-1}
THERM_OK=${F_THERM_OK:-1}; GATE_CPU_IDLE=${F_GATE_CPU_IDLE:-25}; REQ_CPU_IDLE=${F_REQ_CPU_IDLE:-25}; CUR_REQ_CPU=0
TRIES_S=${F_ARM_TRIES_S:-2}; TRIES_L=${F_ARM_TRIES_L:-2}; TFRAC_S=${F_ARM_THERM_FRAC_S:-1.0}; TFRAC_L=${F_ARM_THERM_FRAC_L:-1.0}; ARM_THERM_FRAC=0.1
mkdir -p "$OUT"
TGT="$HOME/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots/10c35caafbb80f7dc6a7a432cdd11af10a6d4818"
DRAFT="$HOME/Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash/draft"
I4_BIN=${F_I4_BIN:-$W/bin/th-engine-i4-c2c1532}
BASE_BIN=$W/bin/th-engine-base-e452a7b
OLD_BIN=$W/bin/th-engine-old-521c6e0
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
                  "thermal_pressure": sh("notifyutil -g com.apple.system.thermalpressurelevel | awk '{print $2}'"),
                  "top": sh("ps -axo pid,%cpu,rss,comm -r | head -7 | tail -6").splitlines()}))
PY
  tail -1 "$OUT/env.jsonl" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"    env {d['label']}: load {d['loadavg'][0]:.2f}/{d['loadavg'][1]:.2f}/{d['loadavg'][2]:.2f} cpu-idle {d['cpu_idle_pct']}% thermal-pressure {d.get('thermal_pressure')} {d['mem']}\")"
}

waitcpu() { # soft: wait (<= CPU_WAIT s) until whole-machine CPU idle >= 85%
  local t0=$(date +%s) idle
  while :; do
    idle=$(top -l 2 -s 1 -n 0 | grep 'CPU usage' | tail -1 | sed -E 's/.* ([0-9.]+)% idle.*/\1/')
    awk -v a="$idle" 'BEGIN{exit !(a >= 85)}' && break
    [ $(( $(date +%s) - t0 )) -gt $CPU_WAIT ] && break
    sleep 4
  done
  echo "{\"label\":\"$1\",\"at\":\"$(date +%T)\",\"cpu_idle_pct\":$idle,\"waited_s\":$(( $(date +%s) - t0 )),\"loadavg\":\"$(sysctl -n vm.loadavg)\"}" >> "$OUT/quiet.jsonl"
  log "cpu idle ${idle}% (waited $(( $(date +%s) - t0 ))s), load $(sysctl -n vm.loadavg)"
}

therm() { notifyutil -g com.apple.system.thermalpressurelevel | awk '{print $2}'; }
load1() { sysctl -n vm.loadavg | awk '{print $2}'; }

gate() { # $1 label $2 limit_s -> GATE_RESULT: pass | pass2 | soft | soft-thermal (always returns 0)
  local label=$1 lim=$2 t0=$(date +%s) since= lv l1 now tier thr tl
  GATE_RESULT=
  for tier in 1 2; do
    thr=$QLOAD; tl=$lim; [ $tier = 2 ] && { thr=$QLOAD2; tl=$GATE_WAIT2; }
    local ts=$(date +%s); since=
    while :; do
      now=$(date +%s); lv=$(therm); l1=$(load1)
      local ci=100; [ $tier = 2 ] && ci=$(top -l 2 -s 1 -n 0 | grep "CPU usage" | tail -1 | sed -E "s/.* ([0-9.]+)% idle.*/\1/")
      if [ "${lv:-9}" -le "$THERM_OK" ] && awk -v a="$l1" -v b="$thr" -v c="$ci" -v m="$GATE_CPU_IDLE" 'BEGIN{exit !(a < b && c >= m)}'; then
        [ -z "$since" ] && since=$now
        if [ $(( now - since )) -ge $QHOLD ]; then GATE_RESULT=pass; [ $tier = 2 ] && GATE_RESULT=pass2; break; fi
      else
        since=
      fi
      [ $(( now - ts )) -ge $tl ] && break
      sleep 5
    done
    [ -n "$GATE_RESULT" ] && break
  done
  if [ -z "$GATE_RESULT" ]; then
    local t1=$(date +%s)
    while [ "$(therm)" -gt "$THERM_OK" ] && [ $(( $(date +%s) - t1 )) -lt $THERM_WAIT ]; do sleep 5; done
    GATE_RESULT=soft; [ "$(therm)" -gt "$THERM_OK" ] && GATE_RESULT=soft-thermal
  fi
  lv=$(therm); l1=$(load1); now=$(date +%s)
  echo "{\"label\":\"$label\",\"gate\":\"$GATE_RESULT\",\"at\":\"$(date +%T)\",\"waited_s\":$(( now - t0 )),\"thermal\":$lv,\"load1\":$l1,\"loadavg\":\"$(sysctl -n vm.loadavg)\"}" >> "$OUT/gate.jsonl"
  log "[$label] gate $GATE_RESULT: thermal $lv, load1 $l1 (tiers: < $QLOAD within ${lim}s, < $QLOAD2 within ${GATE_WAIT2}s; waited $(( now - t0 ))s)"
  return 0
}

descendants() { local p=$1 c; for c in $(pgrep -P "$p"); do echo "$c"; descendants "$c"; done; }

start_th() { # label bin [ENV=V ...]
  local label=$1 bin=$2 i; shift 2
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then log "port $PORT busy — abort"; return 1; fi
  log "[$label] bin=$(basename $bin) sha256=$(shasum -a 256 "$bin" | cut -c1-16) port=$PORT env=$*"
  env -u TH_BATCH TH_DEBUG_TIMING=1 "$@" "$bin" serve --model "$TGT" --draft "$DRAFT" --port $PORT > "$OUT/$label.server.log" 2>&1 &
  SRV_PID=$!; SRV_PIDS=$SRV_PID
  for i in $(seq 1 300); do
    sleep 1
    curl -s -m 2 127.0.0.1:$PORT/status > "$OUT/$label.status.json" 2>/dev/null && [ -s "$OUT/$label.status.json" ] && { log "[$label] up after ${i}s pid=$SRV_PID"; return 0; }
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
  lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs kill -KILL 2>/dev/null
  log "stopped th pid $SRV_PID"; SRV_PID=; SRV_PIDS=
}

start_splash() { # label
  local label=$1 attempt i r
  if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then log ":8000 busy (not mine) — skipping Splash arm"; return 1; fi
  for attempt in 1 2 3; do
    log "[$label] starting splash (attempt $attempt); $(memory_pressure | tail -1)"
    ( cd "$OUT" && exec nohup splash serve --model incoai/Qwen3.8-27B-Splash >> "$OUT/$label.splash.log" 2>&1 ) &
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

TOP_PID=; THERM_PID=; FREQ_PID=; FP_PID=
cleanup() {
  stop_th; stop_splash
  for v in TOP_PID THERM_PID FREQ_PID FP_PID; do eval "p=\${$v}"; [ -n "$p" ] && kill $p 2>/dev/null; eval "$v="; done
}
trap cleanup EXIT
trap 'log "signal — cleaning up"; cleanup; exit 130' INT TERM

clean() { # attempt.jsonl -> 0 if clean (prints a one-line verdict + mean load1)
  python3 - "$1" "$ARM_LOAD" "$ARM_LOAD_MAX" "$ARM_BAD_FRAC" "$ARM_THERM_FRAC" <<'CLEANPY'
import json, sys, statistics as st
rs = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
L, LM, F, TF = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
n = len(rs); ld = [r.get("loadavg1_start") or 0 for r in rs]; th = [r.get("thermal_start") or 0 for r in rs]
bad_l = sum(1 for x in ld if x >= L); bad_t = sum(1 for x in th if x >= 2); err = sum(1 for r in rs if not r.get("ok"))
dirty = n == 0 or err > 0 or bad_t > TF * n or bad_l > F * n or (ld and max(ld) >= LM)
score = (100.0 * bad_t / n if n else 1e9) + (st.mean(ld) if ld else 0) + 1000 * err
print(f"n={n} err={err} load1 {min(ld or [0]):.2f}-{max(ld or [0]):.2f} mean {st.mean(ld) if ld else 0:.2f} (>= {L}: {bad_l}) thermal>=2: {bad_t} score {score:.2f} -> {'CONTAMINATED' if dirty else 'clean'}")
sys.exit(1 if dirty else 0)
CLEANPY
}

FIRST=1
arm() { # label block_modes -> 0 ok | 4 th server failed | 6 splash skipped
  local label=$1 bmodes=$2 kind eng bin ok lim excl k att verdict crc best= bestload= warm=both
  local envs=()
  case $bmodes in *ttft*) warm=short ;; esac
  case $label in
    i4_*)     kind=th; eng=th-new;  bin=$I4_BIN ;;
    base_*)   kind=th; eng=th-base; bin=$BASE_BIN ;;
    old_*)    kind=th; eng=th-old;  bin=$OLD_BIN ;;
    splash_*) kind=splash; eng=splash ;;
    *) log "unknown arm $label"; return 1 ;;
  esac
  local it8k=3; case $label in old_*) it8k=$OLD_ITERS8K ;; esac
  local CARGS=(--modes "$bmodes" --iters 3 --iters8k $it8k --iters-cold 3 --therm-gate-modes ctx8k --therm-gate-max $THERM_GATE_MAX
               --warmup $warm --ttft-spec $Q/spec_t4.json --ttft-gate-max $TTFT_GATE_MAX --ttft-idle 1
               --passage $Q/passage.txt --passage8k $Q/passage8k.txt --cpu-idle-min $CUR_REQ_CPU --cpu-gate-max $TTFT_GATE_MAX --therm-ok $THERM_OK)
  mkdir -p "$OUT/attempts"
  for k in $(seq 1 $ARM_TRIES); do
    log "=== ARM $label ($eng) attempt $k modes $bmodes warmup $warm"
    envsnap "$label.$k-pre"
    waitcpu "$label.$k"
    $GQ waitquiet 60 3 90 | sed "s/^/{\"arm\":\"$label.$k\",\"gpu\":/; s/$/}/" | tee -a "$OUT/quiet.jsonl" | sed 's/^/    gpu-quiet: /'
    lim=$GATE_WAIT; [ $FIRST = 1 ] && lim=$GATE_WAIT_FIRST; FIRST=0
    gate "$label.$k" $lim
    att="$OUT/attempts/$label.$k.jsonl"; ok=0
    $GQ snap "$OUT/snap-$label.$k-0.json"
    if [ $kind = th ]; then
      start_th "$label.$k" "$bin" ${envs[@]+"${envs[@]}"} && ok=1
      [ $ok = 1 ] && python3 $Q/bq4_client.py --port $PORT --engine $eng --arm $label --out "$att" \
          --log "$OUT/$label.$k.server.log" --pids "$SRV_PIDS" "${CARGS[@]}"
      [ $ok = 1 ] && curl -s -m 5 127.0.0.1:$PORT/status > "$OUT/$label.$k.status_after.json" 2>/dev/null
      excl=$SRV_PIDS
      stop_th
      [ $ok = 1 ] || { log "th arm $label failed to start"; return 4; }
    else
      start_splash "$label.$k" && ok=1
      [ $ok = 1 ] && python3 $Q/bq4_client.py --port 8000 --engine splash --arm $label --out "$att" \
          --status-delta --pids "$SRV_PIDS" "${CARGS[@]}"
      [ $ok = 1 ] && curl -s -m 5 127.0.0.1:8000/status > "$OUT/$label.$k.status_after.json" 2>/dev/null
      excl=$SRV_PIDS
      stop_splash
      [ $ok = 1 ] || { log "splash arm $label skipped (could not start)"; return 6; }
    fi
    $GQ snap "$OUT/snap-$label.$k-1.json"
    $GQ delta "$OUT/snap-$label.$k-0.json" "$OUT/snap-$label.$k-1.json" --exclude "$excl" | sed "s/^/{\"arm\":\"$label.$k\",\"contention\":/; s/$/}/" >> "$OUT/contention.jsonl"
    tail -1 "$OUT/contention.jsonl" | cut -c1-300 | sed 's/^/    contention: /'
    envsnap "$label.$k-post"
    verdict=$(clean "$att"); crc=$?
    echo "{\"arm\":\"$label\",\"attempt\":$k,\"gate\":\"$GATE_RESULT\",\"pids\":\"$excl\",\"verdict\":\"$verdict\"}" >> "$OUT/attempts.jsonl"
    if [ $crc = 0 ]; then
      cat "$att" >> "$RUNS"; log "[$label] attempt $k clean: $verdict"; sleep 3; return 0
    fi
    local ml; ml=$(echo "$verdict" | sed -E 's/.*score ([0-9.]+).*/\1/')
    if [ -z "$best" ] || awk -v a="$ml" -v b="$bestload" 'BEGIN{exit !(a < b)}'; then best=$att; bestload=$ml; fi
    log "[$label] attempt $k $verdict — redo"; sleep 3
  done
  cat "$best" >> "$RUNS"
  echo "{\"arm\":\"$label\",\"kept_dirty\":\"$best\",\"score\":$bestload}" >> "$OUT/attempts.jsonl"
  log "[$label] no clean attempt in $ARM_TRIES — kept the cleanest ($best, score $bestload), flagged"
  return 0
}

top -l 0 -s 3 -n 8 -o cpu -stats pid,command,cpu > "$OUT/top.log" 2>&1 &
TOP_PID=$!
( while :; do echo "$(date +%s) $(therm) $(load1)"; sleep 2; done ) > "$OUT/thermal.log" 2>&1 &
THERM_PID=$!
python3 -u "$Q/gpufreq.py" 2 --loop 100000 > "$OUT/gpufreq.jsonl" 2>&1 &
FREQ_PID=$!
python3 -u "$W/bin/fpmon.py" 64 "$OUT/fp.log" "$W/bin/th-engine" > "$OUT/fpmon.out" 2>&1 &
FP_PID=$!
log "=== fin4d session start; blocks $BLOCKS; S: $ORDER_S ($MODES_S); L: $ORDER_L ($MODES_L); th port $PORT; gate thermal 0 + load1 < $QLOAD / < $QLOAD2 held ${QHOLD}s; $(sysctl -n vm.loadavg); thermal $(therm); swap $(sysctl -n vm.swapusage | awk '{print $6}')"
log "binaries: i4 $(shasum -a 256 $I4_BIN | cut -c1-16) base $(shasum -a 256 $BASE_BIN | cut -c1-16) old $(shasum -a 256 $OLD_BIN | cut -c1-16); splash $(splash --version 2>/dev/null | head -1)"
log "listeners before: $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $1":"$2":"$9}' | grep -E ':(80[0-9][0-9])$' | tr '\n' ' ')"
for blk in $BLOCKS; do
  if [ $blk = S ]; then ord=$ORDER_S; bm=$MODES_S; ARM_TRIES=$TRIES_S; ARM_THERM_FRAC=$TFRAC_S; CUR_REQ_CPU=0; else ord=$ORDER_L; bm=$MODES_L; ARM_TRIES=$TRIES_L; ARM_THERM_FRAC=$TFRAC_L; CUR_REQ_CPU=$REQ_CPU_IDLE; fi
  log "block $blk policy: tries $ARM_TRIES, thermal>=2 dirty fraction $ARM_THERM_FRAC, load dirty: > $ARM_BAD_FRAC at >= $ARM_LOAD or any >= $ARM_LOAD_MAX; ttft gate ${TTFT_GATE_MAX}s ctx8k gate ${THERM_GATE_MAX}s old iters8k $OLD_ITERS8K; arm gate tier 2 needs CPU idle >= ${GATE_CPU_IDLE}%; per-request CPU idle >= ${CUR_REQ_CPU}% (0 = off); thermal ok <= $THERM_OK"
  log "=== BLOCK $blk: arms $ord | modes $bm"
  for a in $ord; do
    arm "$a" "$bm"; rc=$?
    [ $rc = 4 ] && { log "ABORT: th server failed at $a"; exit 4; }
    echo "$blk $a $(date +%T) rc=$rc" >> "$OUT/arms_done.txt"
  done
  log "=== BLOCK $blk done"
done
log "=== fin4d session end; $(sysctl -n vm.loadavg) thermal $(therm)"
log "listeners after: $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $1":"$2":"$9}' | grep -E ':(80[0-9][0-9])$' | tr '\n' ' ')"
[ -s "$OUT/fp.log.guard" ] && { log "GUARD events:"; cat "$OUT/fp.log.guard"; }
exit 0
