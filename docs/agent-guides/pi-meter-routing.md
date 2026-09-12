# Routing pi traffic through Token Horizon meters

Pi (`@earendil-works/pi-coding-agent`) resolves provider endpoints at startup
by merging the remote model catalog over local config. A `baseUrl` set on a
provider in `~/.pi/agent/models.json` is **silently ignored** whenever the
provider's models also exist in `~/.pi/agent/models-store.json`, because
`mergeModels` replaces local model entries wholesale on id match — including
their `baseUrl`. Requests then go direct to the upstream and Token Horizon
meters see nothing (`seen=0` on `GET /meters`).

This runbook makes pi traffic metered. It is idempotent — safe to re-run.

## 1. Confirm the meter is listening

```bash
curl -s localhost:8765/meters | python3 -c \
  "import json,sys; [print(m['vendor'], m['listen_port']) for m in json.load(sys.stdin)['point']]"
```

Expect `kimi 9246` (and any other vendors you need). If a vendor is missing,
enable it first (daemon settings toggle or `POST /meters/toggle`).

## 2. Point the store at the meter

`models-store.json` is the effective config, not `models.json`. Rewrite every
upstream `baseUrl` for the provider to the loopback meter (backup first):

```bash
cp ~/.pi/agent/models-store.json ~/.pi/agent/models-store.json.bak
python3 - <<'EOF'
import json
p = '/home/wockhardt/.pi/agent/models-store.json'
# ^ adjust home dir as needed
d = json.load(open(p))
TARGETS = {
    'https://api.kimi.com/coding': 'http://127.0.0.1:9246/coding',
}
def fix(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == 'baseUrl' and v in TARGETS:
                o[k] = TARGETS[v]
            else:
                fix(v)
    elif isinstance(o, list):
        for v in o:
            fix(v)
fix(d)
json.dump(d, open(p, 'w'), indent=2)
EOF
grep -o '"baseUrl": "[^"]*"' ~/.pi/agent/models-store.json | sort | uniq -c
```

All rows for the provider must now show the `127.0.0.1` meter URL.

## 3. Verify end to end

```bash
pi -p --no-session "reply with just the word ok"
curl -s localhost:8765/meters | python3 -c \
  "import json,sys; [print(m['vendor'], 'seen=', m['seen'], 'measured=', m['measured']) for m in json.load(sys.stdin)['point']]"
```

`seen` and `measured` for the vendor must both increment. Then confirm the
row landed:

```bash
sqlite3 ~/.config/token-horizon/usage.db \
  "SELECT vendor, model, input+output FROM usage_event ORDER BY ts DESC LIMIT 1;"
```

## 4. Tool attribution

Pi sends no `User-Agent`, so live metered rows carry no product label until
files are consolidated. Run consolidation (or enable `TH_FILE_POLL=1` on the
daemon for the 60s poll) so `PiConsolidator` joins product `pi` via the
provider `responseId`:

```bash
curl -s -X POST localhost:8765/consolidate
```

## Caveats

- `pi update --models` refreshes the catalog but current pi versions merge
  without overwriting a patched `baseUrl` (verified on 0.85.1). If a future
  pi release reverts the store, re-run step 2 (the `.bak` + this script).
- Do NOT rely on `models.json` provider `baseUrl` alone — it is ignored for
  catalog-listed models. Upstream issue draft:
  `./upstream-issues/earendil-works-pi-baseurl-override.md`.
- `--no-session` pi runs are measured but can never be product-attributed
  (no session file → no annotation). Interactive runs attribute normally.
