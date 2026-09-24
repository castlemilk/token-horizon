package mitm

// The mitmproxy addon deployed by the Manager (Metering/Mitm/MitmAddonScript
// port). This is the TLS-side brain of MITM capture mode; it emits the SAME
// UsageEvents the point-mode meters emit (POSTed to the loopback API's
// /analytics/events), so the store/analytics/sync pipeline is identical for
// both capture modes.
//
// SCOPING: tls_clienthello passes every connection whose SNI is not an AI
// vendor API host through UNDECRYPTED — banking, mail, corporate traffic is
// never terminated. Only the vendor hosts below (the same set the point-mode
// meters target) are intercepted.
//
// The UA table is interpolated from meter.UATable() — the SAME table the
// point-mode meter uses; Go and Python paths cannot drift (test-asserted).

import (
	"fmt"
	"strings"

	"github.com/castlemilk/token-horizon/daemons/go/internal/capture/meter"
)

// Source: the full addon Python source with the UA table interpolated.
func Source() string {
	var rows strings.Builder
	for _, row := range meter.UATable() {
		fmt.Fprintf(&rows, "    (%q, %q),\n", row[0], row[1])
	}
	return sourcePrefix + rows.String() + sourceSuffix
}

const sourcePrefix = `# token-horizon scoped MITM addon (mitmproxy 8+).
# Measures AI vendor API traffic and emits UsageEvents to the loopback API.
# Everything not in VENDOR_HOSTS is passed through undecrypted.

import hashlib
import json
import os
import pathlib
import time
import urllib.request
import uuid

from mitmproxy import ctx

# host -> canonical vendor (mirror of the point-mode meter targets)
VENDOR_HOSTS = {
    "api.anthropic.com": "claude",
    "api.openai.com": "openai",
    "chatgpt.com": "codex",
    "api.moonshot.cn": "kimi",
    "api.moonshot.ai": "kimi",
    "open.bigmodel.cn": "glm",
    "api.minimax.io": "minimax",
    "generativelanguage.googleapis.com": "gemini",
    "dashscope.aliyuncs.com": "alibaba",
    "api.deepseek.com": "deepseek",
    "opencode.ai": "opencode-go",
}

METERED_MARKERS = (
    "/v1/messages", "/messages",
    "/v1/chat/completions", "/chat/completions",
    "/v1/responses", "/responses", "/backend-api/codex/responses",
    ":generatecontent", ":streamgeneratecontent",
)

UA_TABLE = [
`

const sourceSuffix = `]

_api_port = None
_machine_id = None


def load(loader):
    # stream bodies to the client immediately (interactive SSE tools must
    # not be held until completion); full content is still available at the
    # response hook.
    ctx.options.stream_large_bodies = "0"


def tls_clienthello(data):
    sni = getattr(data.client_hello, "sni", None) or ""
    if sni.lower() not in VENDOR_HOSTS:
        data.ignore_connection = True  # passthrough — NEVER decrypted


def api_port():
    global _api_port
    if _api_port:
        return _api_port
    for port in range(8765, 8785):
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:%d/health" % port, timeout=1) as resp:
                if resp.status == 200:
                    _api_port = port
                    return port
        except Exception:
            continue
    return None


def machine_id():
    global _machine_id
    if _machine_id:
        return _machine_id
    candidates = []
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        candidates.append(os.path.join(xdg, "token-horizon", "machine-id"))
    candidates += [
        os.path.expanduser("~/.config/token-horizon/machine-id"),
        os.path.expanduser("~/Library/Application Support/token-horizon/machine-id"),
    ]
    for path in candidates:
        try:
            _machine_id = pathlib.Path(path).read_text().strip()
            if _machine_id:
                return _machine_id
        except Exception:
            pass
    return "mitm-external"


def account_key(vendor, headers):
    for name in ("authorization", "x-api-key", "api-key", "x-goog-api-key"):
        value = headers.get(name)
        if value:
            if value.lower().startswith("bearer "):
                value = value[7:]
            digest = hashlib.sha256(value.encode()).hexdigest()[:16]
            return "%s:%s" % (vendor, digest)
    return None


def product_sniff(headers):
    ua = (headers.get("user-agent") or "").lower()
    for needle, product in UA_TABLE:
        if needle in ua:
            return product
    return None


def sse_objects(text):
    for line in text.split("\n"):
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            continue
        try:
            yield json.loads(payload)
        except Exception:
            continue


def empty_tokens():
    return {"input": 0, "output": 0, "reasoning": 0,
            "cacheRead": 0, "cacheWrite": 0}


def parse_anthropic(body):
    tokens = empty_tokens()
    saw = False
    body_id = None
    stripped = body.lstrip()
    if stripped.startswith(b"event:") or stripped.startswith(b"data:"):
        for obj in sse_objects(body.decode("utf-8", "replace")):
            kind = obj.get("type")
            if kind == "message_start":
                message = obj.get("message") or {}
                body_id = message.get("id") or body_id
                usage = message.get("usage") or {}
                tokens["input"] = int(usage.get("input_tokens") or 0)
                tokens["cacheRead"] = int(usage.get("cache_read_input_tokens") or 0)
                tokens["cacheWrite"] = int(usage.get("cache_creation_input_tokens") or 0)
                saw = True
            elif kind == "message_delta":
                usage = obj.get("usage") or {}
                details = usage.get("output_tokens_details") or {}
                if details.get("thinking_tokens") is not None:
                    tokens["reasoning"] = int(details.get("thinking_tokens") or 0)
                    saw = True
                if usage.get("output_tokens") is not None:
                    # Gross includes thinking — store NET (already-net kept).
                    gross = int(usage.get("output_tokens") or 0)
                    tokens["output"] = gross - tokens["reasoning"] if tokens["reasoning"] <= gross else gross
                    saw = True
    else:
        try:
            obj = json.loads(body)
            body_id = obj.get("id")
            usage = obj.get("usage") or {}
            details = usage.get("output_tokens_details") or {}
            tokens["reasoning"] = int(details.get("thinking_tokens") or 0)
            tokens["input"] = int(usage.get("input_tokens") or 0)
            gross = int(usage.get("output_tokens") or 0)
            tokens["output"] = gross - tokens["reasoning"] if tokens["reasoning"] <= gross else gross
            tokens["cacheRead"] = int(usage.get("cache_read_input_tokens") or 0)
            tokens["cacheWrite"] = int(usage.get("cache_creation_input_tokens") or 0)
            saw = tokens["input"] + tokens["output"] + tokens["reasoning"] > 0
        except Exception:
            pass
    return (tokens if saw else None), body_id


def fill_openai_usage(tokens, usage):
    # Alternate spellings (chat vs Responses API) are the same counters —
    # max, never sum. Gross counters still include the subsets; netting
    # happens in normalize_openai before emit (see TokenBreakdown).
    gross_in = max(int(usage.get("prompt_tokens") or 0), int(usage.get("input_tokens") or 0))
    gross_out = max(int(usage.get("completion_tokens") or 0), int(usage.get("output_tokens") or 0))
    reasoning = 0
    for key in ("completion_tokens_details", "output_tokens_details"):
        details = usage.get(key) or {}
        reasoning = max(reasoning, int(details.get("reasoning_tokens") or 0))
    cached = 0
    for key in ("prompt_tokens_details", "input_tokens_details"):
        details = usage.get(key) or {}
        cached = max(cached, int(details.get("cached_tokens") or 0))
    tokens["input"] = max(tokens["input"], gross_in)
    tokens["output"] = max(tokens["output"], gross_out)
    tokens["reasoning"] = max(tokens["reasoning"], reasoning)
    tokens["cacheRead"] = max(tokens["cacheRead"], cached)


def normalize_openai(tokens):
    # cached/reasoning are USUALLY subsets of the gross counters — store NET
    # so total == provider truth. Already-net payloads (subset > gross) are
    # kept as-is, never zeroed into a loss.
    if tokens["cacheRead"] <= tokens["input"]:
        tokens["input"] -= tokens["cacheRead"]
    if tokens["reasoning"] <= tokens["output"]:
        tokens["output"] -= tokens["reasoning"]


def parse_openai(body):
    tokens = empty_tokens()
    saw = False
    body_id = None
    stripped = body.lstrip()
    # Streams may start with event: (Zen emits event:/data: pairs) or data:.
    if stripped.startswith(b"data:") or stripped.startswith(b"event:"):
        for obj in sse_objects(body.decode("utf-8", "replace")):
            if obj.get("id"):
                body_id = body_id or obj.get("id")
            if obj.get("usage"):
                fill_openai_usage(tokens, obj["usage"])
                saw = True
            response = obj.get("response")
            if isinstance(response, dict):
                if response.get("id"):
                    body_id = body_id or response.get("id")
                if response.get("usage"):
                    fill_openai_usage(tokens, response["usage"])
                    saw = True
    else:
        try:
            obj = json.loads(body)
            body_id = obj.get("id")
            if obj.get("usage"):
                fill_openai_usage(tokens, obj["usage"])
                saw = True
        except Exception:
            pass
    if saw:
        normalize_openai(tokens)
    return (tokens if saw else None), body_id


def parse_gemini(body, path):
    tokens = empty_tokens()
    saw = False
    model = ""
    if "/models/" in path:
        rest = path.split("/models/", 1)[1]
        model = rest.split(":", 1)[0]

    def apply(meta):
        # snake_case vs camelCase are alternate spellings — max, never sum
        # (mirrors GeminiUsageBreakdown in core).
        def pick(*keys):
            return max(int(meta.get(k) or 0) for k in keys)
        cached = pick("cached_content_token_count", "cachedContentTokenCount")
        gross = pick("prompt_token_count", "promptTokenCount")
        # promptTokenCount INCLUDES cached — store NET (already-net kept).
        tokens["input"] = gross - cached if cached <= gross else gross
        tokens["output"] = pick("candidates_token_count", "candidatesTokenCount")
        tokens["reasoning"] = pick("thoughts_token_count", "thoughtsTokenCount")
        tokens["cacheRead"] = cached
        if sum(tokens.values()) == 0:
            # Bare-total payloads (some channels omit components) —
            # attribute the whole as input, like GeminiUsage.
            total = pick("total_token_count", "totalTokenCount")
            if total > 0:
                tokens["input"] += total

    stripped = body.lstrip()
    try:
        if stripped.startswith(b"data:"):
            for obj in sse_objects(body.decode("utf-8", "replace")):
                if obj.get("usageMetadata"):
                    apply(obj["usageMetadata"])
                    saw = True
        else:
            obj = json.loads(body)
            if obj.get("usageMetadata"):
                apply(obj["usageMetadata"])
                saw = True
    except Exception:
        pass
    return (tokens if saw else None), model


def response(flow):
    host = flow.request.pretty_host.lower()
    vendor = VENDOR_HOSTS.get(host)
    if not vendor or flow.response is None:
        return
    if flow.request.method != "POST" or flow.response.status_code != 200:
        return
    path = flow.request.path.lower().split("?")[0]
    if not any(marker in path for marker in METERED_MARKERS):
        return
    body = flow.response.get_content(strict=False) or b""
    model = ""
    request_id_alt = None
    if vendor == "claude" or host.endswith("moonshot.cn") or host.endswith("moonshot.ai"):
        tokens, request_id_alt = parse_anthropic(body)
    elif vendor == "gemini":
        tokens, model = parse_gemini(body, path)
    else:
        tokens, request_id_alt = parse_openai(body)
    if not tokens or sum(tokens.values()) <= 0:
        return
    headers = flow.request.headers
    if not model:
        try:
            model = json.loads(flow.request.get_content(strict=False) or b"{}").get("model") or ""
        except Exception:
            model = ""
    latency_ms = 0
    try:
        latency_ms = int((flow.response.timestamp_end - flow.request.timestamp_start) * 1000)
    except Exception:
        pass
    event = {
        "id": str(uuid.uuid4()).upper(),
        "timestamp": time.time(),
        "machineID": machine_id(),
        "source": "external",
        "vendor": vendor,
        "model": model,
        "tokens": tokens,
        "cost": 0.0,
        "latencyMs": latency_ms,
        "product": product_sniff(headers),
        "productSource": "headerSniffed" if product_sniff(headers) else None,
        "accountID": account_key(vendor, headers),
        "requestID": flow.response.headers.get("request-id"),
        "requestIDAlt": request_id_alt,
        "attestation": "measured",
    }
    event = {k: v for k, v in event.items() if v is not None}
    port = api_port()
    if not port:
        return
    payload = json.dumps(event).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:%d/analytics/events" % port,
        data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        global _api_port
        _api_port = None  # rediscover next time
`
