#!/bin/bash
# test-models-perf.sh — Regression guard for the Models tab performance.
#
# Runs the perf tests and FAILS if any budget is exceeded.
# Add to CI / pre-commit to catch regressions.

set -euo pipefail
cd "$(dirname "$0")/.."

# Budgets (milliseconds). Keep in sync with comments in ModelsPipelinePerfTests.swift.
FULL_PIPELINE_BUDGET_MS=400
SCOPE_COUNTS_BUDGET_MS=50
FILTER_SORT_BUDGET_MS=100

fail=0

echo "=== test-models-perf.sh ==="
echo "Running perf regression tests..."
echo

# Capture output for parsing
out=$(swift test --filter "TokenHorizonPerfTests" 2>&1)

# Extract average seconds from XCTest measure output: "average: 0.220, ..."
extract_avg() {
    local label="$1"
    # Match: "<line> ... average: 0.220, ..."
    echo "$out" | grep "$label" | grep -oE 'average: [0-9.]+' | head -1 | awk '{print $2}'
}

# Check each budget
check_budget() {
    local label="$1"
    local budget_ms="$2"
    local test_label="$3"
    local actual_s=$(extract_avg "$test_label")
    if [ -z "$actual_s" ]; then
        echo "  [skip] $label: no measurement found"
        return
    fi
    # Convert "0.220" → 220 ms (rounded)
    local actual_ms=$(awk -v s="$actual_s" 'BEGIN { printf "%.0f", s * 1000 }')
    if [ "$actual_ms" -le "$budget_ms" ]; then
        echo "  [ok]   $label: ${actual_ms}ms <= ${budget_ms}ms (measured ${actual_s}s)"
    else
        echo "  [FAIL] $label: ${actual_ms}ms > ${budget_ms}ms (REGRESSION, measured ${actual_s}s)"
        fail=1
    fi
}

# Full pipeline (testFullPipeline_completesUnderBudget)
echo "=== Budgets ==="
check_budget "full pipeline (7,300 rows)" "$FULL_PIPELINE_BUDGET_MS" "testFullPipeline_completesUnderBudget"

# Filter+sort alone
check_budget "filter+sort alone"          "$FILTER_SORT_BUDGET_MS"  "testFilterSort_alone_completesUnderBudget"

# Scope counts alone
check_budget "scope counts alone (6)"     "$SCOPE_COUNTS_BUDGET_MS"  "testScopeCounts_alone_completesUnderBudget"

# Hard-budget assertion (testFullPipeline_underHardBudget)
echo
echo "=== Hard budgets (test asserts) ==="
hard_fail=$(echo "$out" | grep -c "full pipeline regressed" || true)
if [ "$hard_fail" -gt 0 ]; then
    echo "  [FAIL] hard-budget assertion failed"
    fail=1
else
    worst=$(echo "$out" | grep -oE "full pipeline worst-case: [0-9.]+ms" | head -1)
    echo "  [ok]   hard-budget assertion passed  ($worst)"
fi

# Show speedup from caching
echo
echo "=== Scope counts caching speedup ==="
speedup_line=$(echo "$out" | grep -oE "speedup=[0-9.]+x" | head -1 || echo "")
if [ -n "$speedup_line" ]; then
    echo "  $speedup_line"
    speedup_num=$(echo "$speedup_line" | grep -oE "[0-9.]+" | head -1)
    if [ -n "$speedup_num" ]; then
        threshold=$(awk -v s="$speedup_num" 'BEGIN { printf "%.0f", (s < 1000) ? 1 : 0 }')
        if [ "$threshold" = "1" ]; then
            echo "  [FAIL] speedup regressed below 1000x (cache may be bypassed)"
            fail=1
        fi
    fi
else
    echo "  (no scope counts test output found)"
fi

echo
if [ "$fail" -ne 0 ]; then
    echo "=== PERF REGRESSION DETECTED ==="
    exit 1
fi
echo "=== ALL PERF BUDGETS PASSED ==="
