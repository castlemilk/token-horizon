#!/usr/bin/env bash
# Regenerates docs/data/models.json — the static model catalog behind
# token-horizon.dev/models and the dashboard's Models explorer.
#
# The export runs the app's own merge pipeline (ModelCatalog + ModelsPipeline),
# so the web list is byte-for-byte the list the MODELS tab renders.
#
# Usage:
#   scripts/models/refresh-models.sh            # build if needed, refresh remote feeds
#   REFRESH=0 scripts/models/refresh-models.sh  # export the local cache only (offline)
#   TH_BIN=... scripts/models/refresh-models.sh # use an existing binary
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

OUT="${OUT:-docs/data/models.json}"
REFRESH="${REFRESH:-1}"
BIN="${TH_BIN:-.build/release/TokenHorizon}"

if [[ "${TH_NO_BUILD:-0}" != "1" ]]; then
  # Incremental; ensures the binary actually contains --export-model-catalog
  # (a stale .build/release/TokenHorizon launched the GUI and crashed headless).
  echo "==> building release binary ($BIN)"
  swift build -c release --product TokenHorizon
fi

if [[ ! -x "$BIN" ]]; then
  echo "missing binary $BIN (set TH_BIN or unset TH_NO_BUILD)" >&2
  exit 1
fi

export TH_GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
export TH_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

args=(--export-model-catalog "$OUT")
[[ "$REFRESH" == "1" ]] && args+=(--refresh)

echo "==> exporting catalog (refresh=$REFRESH) -> $OUT"
"$BIN" "${args[@]}"

python3 - "$OUT" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
print(f"==> {d['count']} models from {d['catalogCount']} catalog keys "
      f"({len(d['providers'])} providers, {len(d['topPicks'])} top picks) "
      f"@ {d['build']['commit']}")
PY
