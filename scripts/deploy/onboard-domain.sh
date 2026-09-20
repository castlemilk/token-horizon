#!/usr/bin/env bash
# onboard-domain.sh — Add a domain to Cloudflare and print the nameserver
# cutover steps for the registrar (Vercel Domains).
#
# Requires an API token with at least: Zone:Edit, DNS:Edit.
# The wrangler OAuth login cannot create zones, so this needs a scoped token:
#   Cloudflare Dashboard → My Profile → API Tokens → Create Token
#   Permissions: Account → Zone → Edit  +  Zone → DNS → Edit
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... ./scripts/onboard-domain.sh [domain]
#   CLOUDFLARE_API_TOKEN=... ./scripts/onboard-domain.sh --check [domain]
#
# After the zone is Active, run: ./scripts/deploy/deploy-cloudflare.sh
set -euo pipefail

DOMAIN="token-horizon.dev"
MODE="create"
for arg in "$@"; do
    case "$arg" in
        --check) MODE="check" ;;
        -*) echo "unknown flag: $arg" >&2; exit 2 ;;
        *) DOMAIN="$arg" ;;
    esac
done

API="https://api.cloudflare.com/client/v4"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-2132ccf47ceb5fff234c34d85490470a}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    cat <<EOF
✗ CLOUDFLARE_API_TOKEN is not set.

Two ways to onboard ${DOMAIN}:

  A) Dashboard (2 minutes, no token):
     1. https://dash.cloudflare.com → Add a site → ${DOMAIN} → Free plan
     2. Cloudflare shows two nameservers (e.g. ada.ns.cloudflare.com)
     3. Vercel → Domains → ${DOMAIN} → Nameservers → replace with those two
     4. Wait for "Active", then: ./scripts/deploy/deploy-cloudflare.sh

  B) Scoped API token (this script):
     1. Cloudflare → My Profile → API Tokens → Create Token
        Permissions: Account → Zone → Edit, Zone → DNS → Edit
     2. CLOUDFLARE_API_TOKEN=... ./scripts/onboard-domain.sh ${DOMAIN}
EOF
    exit 1
fi

auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
json=(-H "Content-Type: application/json")

zone_lookup=$(curl -s "${auth[@]}" "${API}/zones?name=${DOMAIN}")
zone_id=$(printf '%s' "$zone_lookup" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d['result'][0]['id'] if d.get('result') else '')
" 2>/dev/null || true)

if [[ -z "$zone_id" && "$MODE" == "check" ]]; then
    echo "✗ Zone ${DOMAIN} is not on this Cloudflare account yet."
    exit 1
fi

if [[ -z "$zone_id" ]]; then
    echo "→ Creating Cloudflare zone for ${DOMAIN}…"
    create=$(curl -s -X POST "${auth[@]}" "${json[@]}" \
        --data "{\"name\":\"${DOMAIN}\",\"account\":{\"id\":\"${ACCOUNT_ID}\"},\"type\":\"full\"}" \
        "${API}/zones")
    zone_id=$(printf '%s' "$create" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if not d.get('success'):
    errs=d.get('errors') or []
    print('ERROR:' + '; '.join(e.get('message','?') for e in errs), file=sys.stderr)
    sys.exit(0)
print(d['result']['id'])
" 2>/tmp/onboard-err)
    if [[ "$zone_id" == ERROR:* || -z "$zone_id" ]]; then
        cat /tmp/onboard-err >&2 || true
        echo "✗ Zone creation failed. Use the dashboard path (option A)." >&2
        exit 1
    fi
    echo "✓ Zone created: ${zone_id}"
fi

zone_json=$(curl -s "${auth[@]}" "${API}/zones/${zone_id}")
ZONE_JSON="$zone_json" python3 - "$DOMAIN" <<'PY'
import json, os, sys
domain = sys.argv[1]
d = json.loads(os.environ["ZONE_JSON"])
z = d.get("result") or {}
status = z.get("status", "unknown")
ns = z.get("name_servers") or []
print(f"  status:      {status}")
print("  nameservers:")
for n in ns:
    print(f"    • {n}")
if status != "active":
    print()
    print("→ Set these two nameservers at your registrar (Vercel → Domains →")
    print(f"  {domain} → Nameservers). Cloudflare activates once they propagate")
    print("  (usually 5–30 min). Re-run with --check to poll status.")
else:
    print()
    print("✓ Zone is active — run ./scripts/deploy/deploy-cloudflare.sh")
PY
