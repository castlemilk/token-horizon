package main

import (
	"encoding/json"
	"strings"
)

// providerPrefixes maps /th-<name>/ routing prefixes to providers. A client
// points its base URL at http://127.0.0.1:11436/th-<name> to force the
// provider; the remainder is classified by wire shape so providers serving
// several protocols (GLM exposes OpenAI- and Anthropic-compatible roots)
// still parse usage correctly.
var providerPrefixes = []struct {
	prefix   string
	provider Provider
}{
	{"/th-openai", ProviderOpenAI},
	{"/th-anthropic", ProviderAnthropic},
	{"/th-kimi", ProviderKimi},
	{"/th-glm", ProviderGLM},
	{"/th-minimax", ProviderMiniMax},
	{"/th-deepseek", ProviderDeepSeek},
	{"/th-qwen", ProviderQwen},
	{"/th-grok", ProviderGrok},
	{"/th-gemini", ProviderGemini},
	{"/th-opencode", ProviderOpenCode},
	{"/th-splash", ProviderSplash},
}

// prefixedProvider matches a path (query allowed) against the /th-<name>
// table, returning the matched prefix and provider. The prefix is matched
// on the clean path only; queries pass through untouched.
func prefixedProvider(path string) (string, Provider, bool) {
	clean := path
	if i := strings.Index(clean, "?"); i >= 0 {
		clean = clean[:i]
	}
	for _, p := range providerPrefixes {
		if clean == p.prefix || strings.HasPrefix(clean, p.prefix+"/") {
			return p.prefix, p.provider, true
		}
	}
	return "", "", false
}

// wireEndpoint classifies an endpoint by path shape alone. Provider-prefixed
// paths arrive already stripped of /th-<name>; suffix/contains matching
// covers providers whose API roots carry extra segments (e.g. GLM coding
// plan serves OpenAI shape under /api/coding/paas/v4).
func wireEndpoint(clean string) Endpoint {
	switch {
	case strings.Contains(clean, ":streamGenerateContent"),
		strings.Contains(clean, ":generateContent"),
		strings.Contains(clean, ":embedContent"),
		strings.Contains(clean, ":countTokens"):
		return EndpointGeminiGenerate
	case strings.Contains(clean, "/chat/completions"):
		return EndpointChatCompletions
	case strings.Contains(clean, "/responses"):
		return EndpointResponses
	case strings.Contains(clean, "/v1/messages"):
		return EndpointMessages
	case strings.HasSuffix(clean, "/completions"), strings.Contains(clean, "/embeddings"):
		return EndpointEmbeddings
	case strings.Contains(clean, "/models"):
		return EndpointModels
	default:
		return EndpointOther
	}
}

// providerFromModel maps a request body's model name to a provider when the
// name is unambiguous (kimi-*, glm-*, deepseek-*, …). "" when unrecognized —
// the caller falls back to path/credential defaults. This lets harnesses
// pointed at the bare gateway URL still attribute correctly.
func providerFromModel(model string) Provider {
	lower := strings.ToLower(model)
	// Locally-served packages carry repo-style ids ("incoai/Qwen3.8-27B-Splash");
	// a bare "qwen*" prefix match would otherwise route a local engine request
	// to dashscope. "-splash" suffix or the incoai org means the engine —
	// generic slash ids (openrouter-style "openai/gpt-4o") keep provider routing.
	if strings.HasSuffix(lower, "-splash") || strings.HasPrefix(lower, "incoai/") {
		return ProviderSplash
	}
	switch {
	case strings.HasPrefix(lower, "claude"):
		return ProviderAnthropic
	case strings.HasPrefix(lower, "gpt") || strings.HasPrefix(lower, "o1") ||
		strings.HasPrefix(lower, "o3") || strings.HasPrefix(lower, "o4") ||
		strings.Contains(lower, "codex"):
		return ProviderOpenAI
	case strings.HasPrefix(lower, "gemini"):
		return ProviderGemini
	case strings.HasPrefix(lower, "kimi") || strings.Contains(lower, "moonshot"):
		return ProviderKimi
	case strings.HasPrefix(lower, "glm") || strings.HasPrefix(lower, "chatglm"):
		return ProviderGLM
	case strings.HasPrefix(lower, "minimax") || strings.Contains(lower, "abab"):
		return ProviderMiniMax
	case strings.HasPrefix(lower, "deepseek"):
		return ProviderDeepSeek
	case strings.HasPrefix(lower, "qwen"):
		return ProviderQwen
	case strings.HasPrefix(lower, "grok"):
		return ProviderGrok
	}
	return ""
}

// bodyModel extracts the model field from a request body, "" on any failure.
func bodyModel(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(body, &obj) != nil {
		return ""
	}
	m, _ := obj["model"].(string)
	return m
}

// InferProvider maps one client request to its upstream provider and
// normalized endpoint. Single-port routing: /th-<name>/ prefixes win, then
// path shape, auth headers disambiguate /v1/models, body shape is the last
// resort. On shared /v1/* paths an unambiguous model name can reroute the
// provider (kimi-cli on a bare OpenAI base URL still lands on kimi).
//
// headers must use lowercased keys.
func InferProvider(path string, headers map[string]string, body []byte) (Provider, Endpoint) {
	clean := path
	if i := strings.Index(clean, "?"); i >= 0 {
		clean = clean[:i]
	}

	// Explicit escape hatches for clients that want zero guessing.
	if prefix, provider, ok := prefixedProvider(clean); ok {
		return provider, wireEndpoint(StripPrefix(clean, prefix))
	}
	if strings.HasPrefix(clean, "/api/") {
		tail := strings.TrimPrefix(clean, "/api/")
		switch {
		case strings.HasPrefix(tail, "chat"):
			return ProviderOllama, EndpointOllamaChat
		case strings.HasPrefix(tail, "generate"):
			return ProviderOllama, EndpointOllamaGenerate
		default:
			return ProviderOllama, EndpointOther
		}
	}
	// Gemini native API: /v1beta/models/<m>:generateContent (also /v1/...
	// for v1-stable). Unprefixed clients land here by path shape.
	if strings.HasPrefix(clean, "/v1beta/") ||
		strings.Contains(clean, ":streamGenerateContent") ||
		strings.Contains(clean, ":generateContent") {
		return ProviderGemini, wireEndpoint(clean)
	}
	if clean == "/v1/messages" || strings.HasPrefix(clean, "/v1/messages/") {
		// Anthropic protocol — but kimi/minimax coding plans also speak it.
		if p := providerFromModel(bodyModel(body)); p != "" && p != ProviderOpenAI {
			return p, EndpointMessages
		}
		return ProviderAnthropic, EndpointMessages
	}
	if strings.HasPrefix(clean, "/v1/responses") {
		if p := providerFromModel(bodyModel(body)); p != "" {
			return p, EndpointResponses
		}
		return ProviderOpenAI, EndpointResponses
	}
	if strings.HasPrefix(clean, "/v1/chat/completions") {
		if p := providerFromModel(bodyModel(body)); p != "" {
			return p, EndpointChatCompletions
		}
		return ProviderOpenAI, EndpointChatCompletions
	}
	if strings.HasPrefix(clean, "/v1/completions") || strings.HasPrefix(clean, "/v1/embeddings") {
		return ProviderOpenAI, EndpointEmbeddings
	}
	if clean == "/v1/models" || strings.HasPrefix(clean, "/v1/models/") {
		// Ambiguous path: Anthropic clients send x-api-key and usually
		// anthropic-version; OpenAI clients send a Bearer key.
		if headers["x-api-key"] != "" || headers["anthropic-version"] != "" {
			return ProviderAnthropic, EndpointModels
		}
		if strings.HasPrefix(strings.ToLower(headers["authorization"]), "bearer sk-ant-") {
			return ProviderAnthropic, EndpointModels
		}
		return ProviderOpenAI, EndpointModels
	}
	if strings.HasPrefix(clean, "/v1/") {
		if headers["x-api-key"] != "" || headers["anthropic-version"] != "" {
			return ProviderAnthropic, EndpointOther
		}
		// Body-shape fallback for SDKs that share /v1/* paths.
		if len(body) > 0 {
			var obj map[string]any
			if json.Unmarshal(body, &obj) == nil {
				if obj["input"] != nil {
					return ProviderOpenAI, EndpointResponses
				}
				if p := providerFromModel(bodyModel(body)); p != "" {
					return p, EndpointOther
				}
			}
		}
		return ProviderOpenAI, EndpointOther
	}
	return ProviderUnknown, EndpointOther
}

// StripPrefix removes a routing prefix (/th-openai, /th-anthropic, …)
// before the path is forwarded upstream.
func StripPrefix(path, prefix string) string {
	rest, ok := strings.CutPrefix(path, prefix)
	if !ok {
		return path
	}
	if rest == "" {
		return "/"
	}
	if strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, "?") {
		return rest
	}
	return "/" + rest
}

// sessionHeaderNames are checked (in order) for a client-supplied session
// identifier. Codex sends session_id; other harnesses use x-session-*
// variants. Header keys beat body-derived keys: CLI session ids group a
// whole harness session rather than a single conversation chain.
var sessionHeaderNames = []string{
	"session_id", "session-id", "x-session-id", "x-session-uuid",
	"x-conversation-id", "x-client-session",
}

// sessionFromHeaders returns the first non-empty session header value.
func sessionFromHeaders(headers map[string]string) string {
	for _, name := range sessionHeaderNames {
		if v := strings.TrimSpace(headers[name]); v != "" {
			return v
		}
	}
	return ""
}

// detectClient classifies the calling harness from User-Agent and a few
// well-known headers. The result is a short fixed-vocabulary label for
// aggregation; "" when nothing recognizable is present.
func detectClient(headers map[string]string) string {
	ua := strings.ToLower(headers["user-agent"])
	originator := strings.ToLower(headers["originator"])
	switch {
	case strings.Contains(ua, "claude-cli") || strings.Contains(ua, "claude-code") ||
		headers["x-app"] == "cli" && strings.Contains(ua, "anthropic"):
		return "claude-code"
	case strings.Contains(originator, "codex") || strings.Contains(ua, "codex"):
		return "codex"
	case strings.Contains(ua, "kimi"):
		return "kimi-cli"
	case strings.Contains(ua, "opencode"):
		return "opencode"
	case strings.Contains(ua, "gemini-cli") || strings.Contains(ua, "geminicli"):
		return "gemini-cli"
	case strings.Contains(ua, "aider"):
		return "aider"
	case strings.Contains(ua, "cursor"):
		return "cursor"
	case strings.Contains(ua, "cline") || strings.Contains(ua, "roo-code"):
		return "cline"
	case strings.Contains(ua, "continue"):
		return "continue"
	case strings.Contains(ua, "zed"):
		return "zed"
	case strings.Contains(ua, "goose"):
		return "goose"
	case strings.Contains(ua, "devin"):
		return "devin"
	case strings.Contains(ua, "openai") && strings.Contains(ua, "python"),
		strings.Contains(ua, "python-httpx"), strings.Contains(ua, "python-requests"):
		return "python"
	case strings.Contains(ua, "node") || strings.Contains(ua, "undici") || strings.Contains(ua, "axios"):
		return "node"
	case strings.Contains(ua, "go-http-client"):
		return "go"
	case strings.Contains(ua, "curl"):
		return "curl"
	}
	return ""
}
