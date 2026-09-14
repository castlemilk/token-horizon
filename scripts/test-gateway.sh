#!/bin/bash
# Live smoke for the token-horizon-gateway sidecar: builds the real binary,
# proxies a split-SSE completion through a stub upstream, and asserts relay
# fidelity + trace capture + read APIs. No provider credentials needed.
set -euo pipefail
cd "$(dirname "$0")/.."

GATEWAY_PORT=${GATEWAY_PORT:-11636}
STUB_PORT=${STUB_PORT:-11637}
TMPDIR_SMOKE=$(mktemp -d "${TMPDIR:-/tmp}/th-gateway-smoke.XXXXXX")
trap 'kill ${GATEWAY_PID:-} ${STUB_PID:-} 2>/dev/null; rm -rf "$TMPDIR_SMOKE"' EXIT

echo "== build (darwin + linux cross-compile portability check)"
(cd gateway && gofmt -l . | grep . && echo "GOFMT-DIRTY" && exit 1 || true)
(cd gateway && go vet ./... && go test ./... >/dev/null && echo "go vet + test OK")
(cd gateway && go build -o "$TMPDIR_SMOKE/token-horizon-gateway" .)
(cd gateway && GOOS=linux GOARCH=amd64 go build -o "$TMPDIR_SMOKE/token-horizon-gateway-linux" .)
echo "darwin + linux builds OK"

echo "== stub upstream (:$STUB_PORT)"
python3 - "$STUB_PORT" <<'PY' &
import sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
SSE = ('data: {"model":"smoke","choices":[{"delta":{}}]}\n\n'
       'data: {"model":"smoke","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":13,"total_tokens":20}}\n\n'
       'data: [DONE]\n')
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        self.rfile.read(ln)
        body = SSE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Ratelimit-Remaining", "99")
        self.end_headers()
        self.wfile.write(body[:len(body)//2]); self.wfile.flush()
        time.sleep(0.05)
        self.wfile.write(body[len(body)//2:])
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
STUB_PID=$!

echo "== gateway (:$GATEWAY_PORT, traces=$TMPDIR_SMOKE/traces)"
TOKEN_HORIZON_LLM_PROXY_PORT="$GATEWAY_PORT" \
TOKEN_HORIZON_OPENAI_UPSTREAM="http://127.0.0.1:$STUB_PORT" \
TOKEN_HORIZON_TRACE_DIR="$TMPDIR_SMOKE/traces" \
TOKEN_HORIZON_INGEST_URL="" \
"$TMPDIR_SMOKE/token-horizon-gateway" >"$TMPDIR_SMOKE/gateway.log" 2>&1 &
GATEWAY_PID=$!
for i in $(seq 1 50); do
    curl -sf -m 1 "http://127.0.0.1:$GATEWAY_PORT/__token_horizon" >/dev/null 2>&1 && break
    sleep 0.1
done

fail() { echo "SMOKE-FAIL: $1"; echo "--- gateway.log"; cat "$TMPDIR_SMOKE/gateway.log"; exit 1; }

echo "== assertions"
curl -sf "http://127.0.0.1:$GATEWAY_PORT/__token_horizon" | grep -q token-horizon-llm-gateway || fail "info"
HDRS="$TMPDIR_SMOKE/headers.txt"
curl -s -D "$HDRS" -o "$TMPDIR_SMOKE/body.sse" -m 10 "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" \
    -H 'Content-Type: application/json' -H 'Authorization: Bearer test' \
    -d '{"model":"smoke","messages":[],"stream":true}' || fail "proxy POST"
grep -q '"prompt_tokens":7' "$TMPDIR_SMOKE/body.sse" || fail "SSE body relay"
grep -qi 'x-token-horizon-trace-id' "$HDRS" || fail "trace-id header"
grep -qi 'x-ratelimit-remaining: 99' "$HDRS" || fail "ratelimit relay"
TRACE_ID=$(grep -i 'x-token-horizon-trace-id' "$HDRS" | tr -d '\r' | awk '{print $2}')
[ -n "$TRACE_ID" ] || fail "empty trace id"
[ "$(curl -s "http://127.0.0.1:$GATEWAY_PORT/nope" -o /dev/null -w '%{http_code}')" = "400" ] || fail "unknown path 400"
sleep 0.3
curl -sf "http://127.0.0.1:$GATEWAY_PORT/traces" | grep -q '"count":1' || fail "traces list"
curl -sf "http://127.0.0.1:$GATEWAY_PORT/traces" | grep -q 'requestBody' && fail "list must omit bodies"
curl -sf "http://127.0.0.1:$GATEWAY_PORT/traces/$TRACE_ID" | grep -q '"inputTokens":7' || fail "trace detail"
curl -sf "http://127.0.0.1:$GATEWAY_PORT/traces/nope" >/dev/null && fail "missing trace should 404" || true
curl -sf "http://127.0.0.1:$GATEWAY_PORT/proxy/stats?hours=24" | grep -q '"requests":1' || fail "stats"
curl -sf "http://127.0.0.1:$GATEWAY_PORT/metrics" | grep -q 'token_horizon_gateway_requests_total' || fail "metrics"
curl -sf "http://127.0.0.1:$GATEWAY_PORT/proxy/config" | grep -q '"gateway_port"' || fail "config"
[ "$(find "$TMPDIR_SMOKE/traces" -name '*.jsonl' | wc -l | tr -d ' ')" = "1" ] || fail "day file"
python3 - "$TMPDIR_SMOKE"/traces/*.jsonl <<'PY' || fail "jsonl content"
import json, sys
lines = [l for l in open(sys.argv[1]).read().split("\n") if l.strip()]
assert len(lines) == 1, lines
d = json.loads(lines[0])
assert d["usage"]["outputTokens"] == 13, d
assert d["provider"] == "openai" and d["errorClass"] == "none", d
PY

echo "SMOKE-PASS: gateway relay + traces + APIs verified on :$GATEWAY_PORT"
