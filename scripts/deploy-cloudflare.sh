#!/usr/bin/env bash
# deploy-cloudflare.sh — Turnkey Cloudflare Edge Webhosting & R2 Leaderboard Deployment
#
# Deploys the Token Horizon Leaderboard to Cloudflare Workers with:
# - Edge Webhosting serving docs/ (HTML, CSS, assets)
# - Cloudflare R2 Object Storage for sub-20ms global edge persistence
# - Dynamic SVG badges for GitHub profile READMEs
# - REST APIs: GET /api/leaderboard, POST /api/leaderboard, GET /api/share

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CF_DIR="${ROOT_DIR}/cloudflare"

echo "🌌 Token Horizon — Cloudflare Edge Webhosting & R2 Deployment"
echo "=============================================================="

# 1. Resolve Wrangler
WRANGLER_BIN=""
if command -v wrangler >/dev/null 2>&1; then
    WRANGLER_BIN="wrangler"
elif [[ -x "${ROOT_DIR}/node_modules/.bin/wrangler" ]]; then
    WRANGLER_BIN="${ROOT_DIR}/node_modules/.bin/wrangler"
elif [[ -x "${CF_DIR}/node_modules/.bin/wrangler" ]]; then
    WRANGLER_BIN="${CF_DIR}/node_modules/.bin/wrangler"
else
    WRANGLER_BIN="npx wrangler"
fi

echo "✓ Using Wrangler: $WRANGLER_BIN"

# 2. Check Cloudflare Login Status
echo "Checking Cloudflare credentials..."
if ! $WRANGLER_BIN whoami >/dev/null 2>&1; then
    echo "⚠️  Wrangler is not logged in. Running wrangler login..."
    $WRANGLER_BIN login
fi

# 3. Create R2 Bucket if it doesn't already exist
BUCKET_NAME="token-horizon-leaderboard"
echo "Ensuring Cloudflare R2 bucket exists: ${BUCKET_NAME}..."
if ! $WRANGLER_BIN r2 bucket create "${BUCKET_NAME}" 2>/dev/null; then
    echo "✓ R2 bucket '${BUCKET_NAME}' is ready (or already exists)."
fi

# 4. Deploy Cloudflare Worker + Assets
echo "Deploying Cloudflare Worker + Static Web Assets from docs/..."
(
    cd "${CF_DIR}"
    $WRANGLER_BIN deploy
)

echo
echo "=============================================================="
echo "🎉 Cloudflare Deployment Complete!"
echo "=============================================================="
echo "Your Token Horizon Leaderboard is live on Cloudflare's global edge network."
echo
echo "Endpoints:"
echo "  • Web Dashboard:  https://token-horizon-leaderboard.<subdomain>.workers.dev/leaderboard.html"
echo "  • REST API:       https://token-horizon-leaderboard.<subdomain>.workers.dev/api/leaderboard"
echo "  • Dynamic SVG:    https://token-horizon-leaderboard.<subdomain>.workers.dev/api/share?format=svg"
echo
echo "To connect your local Token Horizon Mac app:"
echo "  th leaderboard config cf https://token-horizon-leaderboard.<subdomain>.workers.dev"
echo
echo "To publish your latest usage to the edge:"
echo "  th leaderboard publish --cf"
echo "=============================================================="
