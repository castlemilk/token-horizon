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
	// Non-default providers are reached via /th-<name>/ routing prefixes;
	// the base may carry a path root (e.g. Kimi coding = api.kimi.com/coding).
	OpenAIBase    string
	AnthropicBase string
	OllamaBase    string
	KimiBase      string
	GLMBase       string
	MiniMaxBase   string
	DeepSeekBase  string
	QwenBase      string
	GrokBase      string
	GeminiBase    string
	OpenCodeBase  string
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
		KimiBase:      envOr("TOKEN_HORIZON_KIMI_UPSTREAM", "https://api.kimi.com/coding"),
		GLMBase:       envOr("TOKEN_HORIZON_GLM_UPSTREAM", "https://api.z.ai"),
		MiniMaxBase:   envOr("TOKEN_HORIZON_MINIMAX_UPSTREAM", "https://api.minimax.io"),
		DeepSeekBase:  envOr("TOKEN_HORIZON_DEEPSEEK_UPSTREAM", "https://api.deepseek.com"),
		QwenBase:      envOr("TOKEN_HORIZON_QWEN_UPSTREAM", "https://dashscope.aliyuncs.com"),
		GrokBase:      envOr("TOKEN_HORIZON_GROK_UPSTREAM", "https://api.x.ai"),
		GeminiBase:    envOr("TOKEN_HORIZON_GEMINI_UPSTREAM", "https://generativelanguage.googleapis.com"),
		OpenCodeBase:  envOr("TOKEN_HORIZON_OPENCODE_UPSTREAM", "https://opencode.ai/zen"),
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

// baseFor returns the configured upstream base for a provider.
func (c Config) baseFor(provider Provider) string {
	switch provider {
	case ProviderOpenAI:
		return c.OpenAIBase
	case ProviderAnthropic:
		return c.AnthropicBase
	case ProviderOllama:
		return c.OllamaBase
	case ProviderKimi:
		return c.KimiBase
	case ProviderGLM:
		return c.GLMBase
	case ProviderMiniMax:
		return c.MiniMaxBase
	case ProviderDeepSeek:
		return c.DeepSeekBase
	case ProviderQwen:
		return c.QwenBase
	case ProviderGrok:
		return c.GrokBase
	case ProviderGemini:
		return c.GeminiBase
	case ProviderOpenCode:
		return c.OpenCodeBase
	}
	return ""
}

// UpstreamURL joins a provider base with the client path (prefix-stripped),
// preserving the client query string verbatim.
func (c Config) UpstreamURL(provider Provider, path string) (*url.URL, bool) {
	base := c.baseFor(provider)
	if base == "" {
		return nil, false
	}
	forward := path
	if prefix, _, ok := prefixedProvider(path); ok && provider != ProviderOllama {
		forward = StripPrefix(path, prefix)
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
