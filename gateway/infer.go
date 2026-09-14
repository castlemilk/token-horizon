package main

import (
	"encoding/json"
	"strings"
)

// InferProvider maps one client request to its upstream provider and
// normalized endpoint. Single-port routing: path wins, auth headers
// disambiguate /v1/models, body shape is the last resort.
//
// headers must use lowercased keys.
func InferProvider(path string, headers map[string]string, body []byte) (Provider, Endpoint) {
	clean := path
	if i := strings.Index(clean, "?"); i >= 0 {
		clean = clean[:i]
	}

	// Explicit escape hatches for clients that want zero guessing.
	if strings.HasPrefix(clean, "/th-openai/") {
		return ProviderOpenAI, openAIEndpoint(strings.TrimPrefix(clean, "/th-openai"))
	}
	if strings.HasPrefix(clean, "/th-anthropic/") {
		return ProviderAnthropic, EndpointMessages
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
	if clean == "/v1/messages" || strings.HasPrefix(clean, "/v1/messages/") {
		return ProviderAnthropic, EndpointMessages
	}
	if strings.HasPrefix(clean, "/v1/responses") {
		return ProviderOpenAI, EndpointResponses
	}
	if strings.HasPrefix(clean, "/v1/chat/completions") {
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
				if model, _ := obj["model"].(string); model != "" {
					lower := strings.ToLower(model)
					if strings.HasPrefix(lower, "claude") {
						return ProviderAnthropic, EndpointOther
					}
					if strings.HasPrefix(lower, "gpt") || strings.HasPrefix(lower, "o1") ||
						strings.HasPrefix(lower, "o3") || strings.HasPrefix(lower, "o4") ||
						strings.Contains(lower, "codex") {
						return ProviderOpenAI, EndpointOther
					}
				}
			}
		}
		return ProviderOpenAI, EndpointOther
	}
	return ProviderUnknown, EndpointOther
}

func openAIEndpoint(path string) Endpoint {
	switch {
	case strings.HasPrefix(path, "/v1/responses"):
		return EndpointResponses
	case strings.HasPrefix(path, "/v1/chat/completions"):
		return EndpointChatCompletions
	case strings.HasPrefix(path, "/v1/embeddings"), strings.HasPrefix(path, "/v1/completions"):
		return EndpointEmbeddings
	case strings.HasPrefix(path, "/v1/models"):
		return EndpointModels
	default:
		return EndpointOther
	}
}

// StripPrefix removes a routing prefix (/th-openai, /th-anthropic) before
// the path is forwarded upstream.
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
