#!/bin/bash
# make-app-with-tests.sh — Release build gated on perf tests.
#
# Same as make-app.sh, but runs the Models tab perf tests first.
# If any budget is breached, the build aborts.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== make-app-with-tests.sh ==="
echo "Step 1/2: running perf regression tests..."
./scripts/test-models-perf.sh

echo
echo "Step 2/2: building release + launching..."
./scripts/make-app.sh
