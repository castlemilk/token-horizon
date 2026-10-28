#!/usr/bin/env bash
# setup-mlx-runtime.sh — build the Token Horizon-managed MLX runtime.
#
# The app's mlx backend (:8002) serves models through a python interpreter
# it discovers in order:
#   1. $TOKEN_HORIZON_MLX_PYTHON
#   2. ~/.config/token-horizon/mlx-runtime/bin/python   ← this script's output
#   3. system pythons (a Homebrew python can't carry the modules — pip there
#      is externally-managed, so a plain `pip install mlx-vlm` fails)
#
# Usage:
#   scripts/setup-mlx-runtime.sh                install/refresh the runtime
#   scripts/setup-mlx-runtime.sh --model <repo> also prefetch a HF checkpoint
#                                              (e.g. RecursiveSI/flint-int4)
#
# Dependencies land under a publish-date cutoff (TH_MLX_CUTOFF) so a resolve
# never picks a brand-new release; mlx-vlm is exempted to its own day — it
# is the only release line that serves Flint (needs >=0.7.10).

set -euo pipefail

RUNTIME="$HOME/.config/token-horizon/mlx-runtime"
CUTOFF="${TH_MLX_CUTOFF:-2026-10-17T13:00:00Z}"
MLX_VLM_CUTOFF="${TH_MLX_VLM_CUTOFF:-2026-10-22T00:00:00Z}"
PYVER="${TH_MLX_PYTHON:-3.12}"

MODELS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODELS+=("${2:?--model needs a HF repo id}"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PY="$RUNTIME/bin/python"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required (brew install uv) — it supplies a managed CPython and" >&2
  echo "enforces the publish-date cutoffs this script relies on." >&2
  exit 1
fi

if [ ! -x "$PY" ]; then
  echo "· creating runtime at $RUNTIME (python $PYVER)"
  uv venv "$RUNTIME" --python "$PYVER"
fi

echo "· installing mlx-lm + mlx-vlm (cutoff $CUTOFF; mlx-vlm exempt → $MLX_VLM_CUTOFF)"
uv pip install --python "$PY" \
  --exclude-newer "$CUTOFF" \
  --exclude-newer-package "mlx-vlm=$MLX_VLM_CUTOFF" \
  'mlx-vlm>=0.7.10' 'mlx-lm>=0.28'

# The vendored Flint loader patches must re-apply after every (re)install —
# they fix the RecursiveSI flint-int4 checkpoint (mlx_export embedding widths
# + U8 byte-view weights). Fails loudly if upstream anchors change.
echo "· applying vendored mlx_vlm patches (flint-int4 loader)"
"$PY" "$SCRIPT_DIR/mlx-runtime-patches/flint-loader-patch.py"

"$PY" - <<'PYEOF'
import mlx.core as mx
import mlx_lm, mlx_vlm
from importlib.metadata import version
ok = mx.metal.is_available()
print(f"· mlx {mx.__version__} (metal: {'yes' if ok else 'NO'})  "
      f"mlx-lm {version('mlx-lm')}  mlx-vlm {version('mlx-vlm')}")
if not ok:
    raise SystemExit("Metal unavailable — MLX cannot serve on this machine")
PYEOF

"$PY" -c "import importlib.metadata as m; \
  v=m.version('mlx-vlm'); \
  ok=tuple(int(x) for x in v.split('.')[:3]) >= (0,7,10); \
  print(f'· flint support: {\"yes\" if ok else \"NO — mlx-vlm >=0.7.10 required\"}'); \
  raise SystemExit(0 if ok else 1)"

for repo in ${MODELS[@]+"${MODELS[@]}"}; do
  echo "· prefetching $repo into the HF cache"
  "$PY" -m huggingface_hub.cli.hf download "$repo"
done

echo "· done — restart Token Horizon if it was already running, then serve"
echo "  via the ENGINE tab or:"
echo "    curl -X POST 127.0.0.1:8889/engine/serve \\"
echo "      -d '{\"backend\":\"mlx\",\"model\":\"<hf-repo-id>\"}'"
