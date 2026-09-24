// Package main implements token-horizon-gateway, a standalone loopback-only
// HTTP reverse proxy that speaks the provider APIs harnesses already use
// (OpenAI chat/completions + responses, Anthropic messages, Ollama native).
//
// Clients point their base URL at it:
//
//	OPENAI_BASE_URL=http://127.0.0.1:11436      (Codex, OpenAI SDKs)
//	ANTHROPIC_BASE_URL=http://127.0.0.1:11436   (Claude Code)
//	OLLAMA_HOST=http://127.0.0.1:11436          (Ollama clients)
//
// Responses stream back unchanged while the gateway captures a bounded
// prefix per side, measures TTFT/duration, and appends a trace record as
// JSONL under ~/.config/token-horizon/traces/. Auth headers pass through
// upstream and are never stored; traces never leave the machine.
//
// Zero dependencies: stdlib only.
package main

import (
	"encoding/json"
	"strconv"
	"time"
)

// Trace JSON schema. Field names are frozen: the Mac app's :8765 API
// reverse-proxies this gateway's read endpoints byte-for-byte, and older
// day files on disk must keep decoding.
type Provider string

const (
	ProviderOpenAI    Provider = "openai"
	ProviderAnthropic Provider = "anthropic"
	ProviderOllama    Provider = "ollama"
	ProviderKimi      Provider = "kimi"
	ProviderGLM       Provider = "glm"
	ProviderMiniMax   Provider = "minimax"
	ProviderDeepSeek  Provider = "deepseek"
	ProviderQwen      Provider = "qwen"
	ProviderGrok      Provider = "grok"
	ProviderGemini    Provider = "gemini"
	ProviderOpenCode  Provider = "opencode"
	ProviderSplash    Provider = "splash"
	ProviderTHEngine  Provider = "thengine"
	ProviderUnknown   Provider = "unknown"
)

// AllProviders is the fixed provider vocabulary for filters and info docs.
var AllProviders = []Provider{
	ProviderOpenAI, ProviderAnthropic, ProviderOllama, ProviderKimi,
	ProviderGLM, ProviderMiniMax, ProviderDeepSeek, ProviderQwen,
	ProviderGrok, ProviderGemini, ProviderOpenCode, ProviderSplash,
	ProviderTHEngine,
}

func knownProvider(p Provider) bool {
	for _, known := range AllProviders {
		if p == known {
			return true
		}
	}
	return p == ProviderUnknown
}

type Endpoint string

const (
	EndpointChatCompletions Endpoint = "chat_completions"
	EndpointResponses       Endpoint = "responses"
	EndpointMessages        Endpoint = "messages"
	EndpointEmbeddings      Endpoint = "embeddings"
	EndpointModels          Endpoint = "models"
	EndpointGeminiGenerate  Endpoint = "gemini_generate"
	EndpointOllamaGenerate  Endpoint = "ollama_generate"
	EndpointOllamaChat      Endpoint = "ollama_chat"
	EndpointOther           Endpoint = "other"
)

type TokenSource string

const (
	// TokenReported means a provider usage block was present in the capture.
	TokenReported TokenSource = "reported"
	// TokenAccumulated means usage was reconstructed from streamed deltas
	// (Anthropic message deltas).
	TokenAccumulated TokenSource = "accumulated"
	// TokenAbsent means no usage was found in the captured prefix. Counts
	// stay nil — they are never estimated.
	TokenAbsent TokenSource = "absent"
)

type ErrorClass string

const (
	ErrNone          ErrorClass = "none"
	ErrAuth          ErrorClass = "auth"
	ErrRateLimited   ErrorClass = "rateLimited"
	ErrOverloaded    ErrorClass = "overloaded"
	ErrContextLength ErrorClass = "contextLength"
	ErrBadRequest    ErrorClass = "badRequest"
	ErrServerError   ErrorClass = "serverError"
	ErrNetwork       ErrorClass = "network"
	ErrCancelled     ErrorClass = "cancelled"
	ErrUnknown       ErrorClass = "unknown"
)

// UnixTime marshals as fractional seconds since epoch (matches the former
// Swift secondsSince1970 encoding and keeps day files greppable numbers).
type UnixTime time.Time

func (t UnixTime) MarshalJSON() ([]byte, error) {
	secs := float64(time.Time(t).UnixNano()) / 1e9
	return []byte(strconv.FormatFloat(secs, 'f', -1, 64)), nil
}

func (t *UnixTime) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*t = UnixTime(time.Time{})
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	*t = UnixTime(time.Unix(0, int64(f*1e9)))
	return nil
}

func (t UnixTime) Time() time.Time { return time.Time(t) }

type Usage struct {
	InputTokens     *int        `json:"inputTokens,omitempty"`
	OutputTokens    *int        `json:"outputTokens,omitempty"`
	TotalTokens     *int        `json:"totalTokens,omitempty"`
	CachedTokens    *int        `json:"cachedTokens,omitempty"`
	ReasoningTokens *int        `json:"reasoningTokens,omitempty"`
	Source          TokenSource `json:"source"`
}

type ToolCall struct {
	Name   string  `json:"name"`
	CallID *string `json:"callId,omitempty"`
}

type Trace struct {
	ID                string     `json:"id"`
	Provider          Provider   `json:"provider"`
	Endpoint          Endpoint   `json:"endpoint"`
	Path              string     `json:"path"`
	Model             string     `json:"model"`
	StartedAt         UnixTime   `json:"startedAt"`
	TTFTMs            *float64   `json:"ttftMs"`
	DurationMs        float64    `json:"durationMs"`
	Stream            bool       `json:"stream"`
	StatusCode        int        `json:"statusCode"`
	Usage             Usage      `json:"usage"`
	ToolCalls         []ToolCall `json:"toolCalls"`
	FinishReasons     []string   `json:"finishReasons"`
	ErrorClass        ErrorClass `json:"errorClass"`
	ErrorMessage      *string    `json:"errorMessage,omitempty"`
	RequestBody       *string    `json:"requestBody,omitempty"`
	ResponseBody      *string    `json:"responseBody,omitempty"`
	RequestTruncated  bool       `json:"requestTruncated"`
	ResponseTruncated bool       `json:"responseTruncated"`
	RequestBytes      int        `json:"requestBytes"`
	ResponseBytes     int        `json:"responseBytes"`
	SessionKey        *string    `json:"sessionKey,omitempty"`
	RequestHash       string     `json:"requestHash"`
	RetrySuspect      bool       `json:"retrySuspect"`
	// Source identifies the capture pipeline ("proxy" for gateway-observed
	// traffic); reserved for future file/OTLP-sourced spans.
	Source string `json:"source,omitempty"`
	// Client is the calling harness classified from User-Agent/headers
	// (claude-code, codex, kimi-cli, opencode, …); empty when unrecognized.
	Client string `json:"client,omitempty"`
	// ProviderRequestID relays the upstream request-id header so traces can
	// be joined against provider-side logs.
	ProviderRequestID *string `json:"providerRequestId,omitempty"`
	// EstCostUSD is reserved for catalog-owning consumers. The gateway has
	// no pricing data by design (decoupling: no catalog dependency), so it
	// always records null here rather than guessing.
	EstCostUSD *float64 `json:"estCostUSD"`
}

// TokPerSec is measured generation throughput: output tokens per active
// second after first token. Nil when the provider reported no output count.
func (t Trace) TokPerSec() *float64 {
	if t.Usage.OutputTokens == nil || *t.Usage.OutputTokens <= 0 || t.DurationMs <= 0 {
		return nil
	}
	active := t.DurationMs
	if t.TTFTMs != nil {
		active -= *t.TTFTMs
	}
	if active <= 1 {
		return nil
	}
	v := float64(*t.Usage.OutputTokens) / (active / 1000)
	return &v
}

// CacheHitRate is the share of input tokens served from prompt cache.
func (t Trace) CacheHitRate() *float64 {
	if t.Usage.InputTokens == nil || *t.Usage.InputTokens <= 0 || t.Usage.CachedTokens == nil {
		return nil
	}
	v := float64(*t.Usage.CachedTokens) / float64(*t.Usage.InputTokens)
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	return &v
}

// Summary returns a copy without bodies for list endpoints.
func (t Trace) Summary() Trace {
	t.RequestBody = nil
	t.ResponseBody = nil
	if t.ToolCalls == nil {
		t.ToolCalls = []ToolCall{}
	}
	if t.FinishReasons == nil {
		t.FinishReasons = []string{}
	}
	return t
}

// ModelStats is the per-(provider, model) efficiency cut.
type ModelStats struct {
	Provider          string   `json:"provider"`
	Model             string   `json:"model"`
	Requests          int      `json:"requests"`
	ErrorCount        int      `json:"errorCount"`
	InputTokens       int      `json:"inputTokens"`
	OutputTokens      int      `json:"outputTokens"`
	CachedTokens      int      `json:"cachedTokens"`
	AvgTTFTMs         *float64 `json:"avgTtftMs"`
	AvgTokPerSec      *float64 `json:"avgTokPerSec"`
	CacheHitRate      *float64 `json:"cacheHitRate"`
	ToolCallRate      float64  `json:"toolCallRate"`
	RetrySuspectCount int      `json:"retrySuspectCount"`
	EstCostUSD        float64  `json:"estCostUSD"`
}

// ProviderStats is the per-provider traffic cut.
type ProviderStats struct {
	Provider     string   `json:"provider"`
	Requests     int      `json:"requests"`
	ErrorCount   int      `json:"errorCount"`
	InputTokens  int      `json:"inputTokens"`
	OutputTokens int      `json:"outputTokens"`
	AvgTTFTMs    *float64 `json:"avgTtftMs"`
	EstCostUSD   float64  `json:"estCostUSD"`
}

// ClientStats is the per-harness traffic cut (claude-code, codex, …).
type ClientStats struct {
	Client     string `json:"client"`
	Requests   int    `json:"requests"`
	ErrorCount int    `json:"errorCount"`
}

// ErrorStat counts one error class in the window.
type ErrorStat struct {
	Class string `json:"class"`
	Count int    `json:"count"`
}

// SessionStats groups traces sharing a session key into one conversation
// span — the cross-provider "distributed trace" view.
type SessionStats struct {
	SessionKey    string   `json:"sessionKey"`
	Requests      int      `json:"requests"`
	ErrorCount    int      `json:"errorCount"`
	Providers     []string `json:"providers"`
	Models        []string `json:"models"`
	Clients       []string `json:"clients"`
	InputTokens   int      `json:"inputTokens"`
	OutputTokens  int      `json:"outputTokens"`
	ToolCallCount int      `json:"toolCallCount"`
	FirstAt       UnixTime `json:"firstAt"`
	LastAt        UnixTime `json:"lastAt"`
	SpanMs        float64  `json:"spanMs"`
}

// Stats aggregates a trace slice into window + per-model efficiency signals.
type Stats struct {
	WindowHours       int             `json:"windowHours"`
	Since             UnixTime        `json:"since"`
	Requests          int             `json:"requests"`
	ErrorCount        int             `json:"errorCount"`
	InputTokens       int             `json:"inputTokens"`
	OutputTokens      int             `json:"outputTokens"`
	CachedTokens      int             `json:"cachedTokens"`
	RetrySuspectCount int             `json:"retrySuspectCount"`
	ToolCallCount     int             `json:"toolCallCount"`
	EstCostUSD        float64         `json:"estCostUSD"`
	ErrorRate         float64         `json:"errorRate"`
	ToolCallRate      float64         `json:"toolCallRate"`
	CacheHitRate      *float64        `json:"cacheHitRate"`
	AvgTTFTMs         *float64        `json:"avgTtftMs"`
	P50DurationMs     *float64        `json:"p50DurationMs"`
	P95DurationMs     *float64        `json:"p95DurationMs"`
	P50TTFTMs         *float64        `json:"p50TtftMs"`
	P95TTFTMs         *float64        `json:"p95TtftMs"`
	ByModel           []ModelStats    `json:"byModel"`
	ByProvider        []ProviderStats `json:"byProvider"`
	ByClient          []ClientStats   `json:"byClient"`
	ByError           []ErrorStat     `json:"byError"`
}

func intPtr(v int) *int           { return &v }
func floatPtr(v float64) *float64 { return &v }
func stringPtr(v string) *string  { return &v }
