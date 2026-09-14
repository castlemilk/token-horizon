package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is the gateway's full runtime configuration. Everything comes
// from the environment so the Mac app (supervisor) and standalone runs
// share one mechanism.
type Config struct {
	// First loopback port to try; the next 19 are attempted on conflict.
	Port uint16
	// Upstream bases. Ollama accepts bare host:port (wrapped as http://).
	OpenAIBase    string
	AnthropicBase string
	OllamaBase    string
	// Trace directory override (tests). Default ~/.config/token-horizon/traces.
	TraceDir string
	// Best-effort POST target for Ollama telemetry samples so the Mac app's
	// usage totals stay correct for gateway-routed local traffic. Empty
	// disables. Default points at the app's :8765 ingest route.
	IngestURL string
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func ConfigFromEnv() Config {
	port := uint16(11436)
	if v := os.Getenv("TOKEN_HORIZON_LLM_PROXY_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65535 {
			port = uint16(n)
		}
	}
	traceDir := os.Getenv("TOKEN_HORIZON_TRACE_DIR")
	if traceDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "."
		}
		traceDir = filepath.Join(home, ".config", "token-horizon", "traces")
	}
	return Config{
		Port:          port,
		OpenAIBase:    envOr("TOKEN_HORIZON_OPENAI_UPSTREAM", "https://api.openai.com"),
		AnthropicBase: envOr("TOKEN_HORIZON_ANTHROPIC_UPSTREAM", "https://api.anthropic.com"),
		OllamaBase:    normalizeBase(envOr("TOKEN_HORIZON_OLLAMA_UPSTREAM", "127.0.0.1:11434"), "http"),
		TraceDir:      traceDir,
		IngestURL:     envOr("TOKEN_HORIZON_INGEST_URL", "http://127.0.0.1:8765/ingest/ollama"),
	}
}

func normalizeBase(raw, scheme string) string {
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return strings.TrimSuffix(raw, "/")
	}
	return scheme + "://" + strings.TrimSuffix(raw, "/")
}

// UpstreamURL joins a provider base with the client path (prefix-stripped),
// preserving the client query string verbatim.
func (c Config) UpstreamURL(provider Provider, path string) (*url.URL, bool) {
	var base, forward string
	switch provider {
	case ProviderOpenAI:
		base, forward = c.OpenAIBase, StripPrefix(path, "/th-openai")
	case ProviderAnthropic:
		base, forward = c.AnthropicBase, StripPrefix(path, "/th-anthropic")
	case ProviderOllama:
		base, forward = c.OllamaBase, path
	default:
		return nil, false
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil, false
	}
	var rawPath, rawQuery string
	if i := strings.Index(forward, "?"); i >= 0 {
		rawPath, rawQuery = forward[:i], forward[i+1:]
	} else {
		rawPath = forward
	}
	if rawPath == "" {
		rawPath = "/"
	}
	joined, err := url.JoinPath(baseURL.String(), rawPath)
	if err != nil {
		return nil, false
	}
	u, err := url.Parse(joined)
	if err != nil {
		return nil, false
	}
	u.RawQuery = rawQuery
	return u, true
}
