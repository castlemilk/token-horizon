#!/bin/bash
# profile-tick.sh — repeatable tick profiler for Token Horizon.
#
# Runs the opt-in TickPerfHarnessTests (TH_PROFILE=1) and prints its timing
# table. With --sample, additionally captures a `sample` profile of the test
# process for hotspot analysis (see /tmp/th-tick-profile.txt).
#
#   ./scripts/dev/profile-tick.sh            # timing table only
#   ./scripts/dev/profile-tick.sh --sample   # + 20s sample profile
#   TH_PERF_LOG=1 ...                    # + per-phase engine spans in output
#
# Numbers are machine- and load-dependent: compare runs on the same idle
# machine, not against other machines. Hard budgets live in the XCTest perf
# suites (ModelsPipelinePerfTests, ScopeCountsCachingTests).
set -euo pipefail
cd "$(dirname "$0")/../.."

SAMPLE=0
if [ "${1:-}" = "--sample" ]; then SAMPLE=1; fi

# Pre-build so the background run starts promptly (sampling windows are blind).
swift build --build-tests 2>&1 | tail -1

LOG=/tmp/th-profile.log
TH_PROFILE=1 swift test --filter "TickPerfHarness" > "$LOG" 2>&1 &
TESTPID=$!

if [ "$SAMPLE" -eq 1 ]; then
    # Wait for the xctest process to spawn (build is done; startup is quick).
    XCPID=""
    for _ in $(seq 1 60); do
        XCPID=$(pgrep -x xctest | head -1 || true)
        [ -n "$XCPID" ] && break
        sleep 2
    done
    if [ -n "$XCPID" ]; then
        echo "sampling xctest pid $XCPID for 20s..."
        sample "$XCPID" 20 -file /tmp/th-tick-profile.txt 2>&1 | tail -1
        echo "profile: /tmp/th-tick-profile.txt"
    else
        echo "WARNING: xctest never appeared; skipping sample"
    fi
fi

wait "$TESTPID"
echo "--- timing table ---"
grep -E "TickPerf" "$LOG" || tail -5 "$LOG"
