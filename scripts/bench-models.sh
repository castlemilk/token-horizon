#!/bin/bash
# bench-models.sh — Measure model tab performance metrics and print results.
#
# Runs the XCTest perf suite and prints a summary.
# Used as a standalone tool for ad-hoc perf measurement.

set -euo pipefail
cd "$(dirname "$0")/../clients/macos"

echo "=== bench-models.sh ==="
echo "Running ModelsPipelinePerfTests (full perf suite)..."
echo

time swift test --filter "TokenHorizonPerfTests.(ModelsPipelinePerfTests|ScopeCountsCachingTests)" 2>&1 | grep -E "average:|cached=|full pipeline worst-case" || true

echo
echo "=== done ==="
