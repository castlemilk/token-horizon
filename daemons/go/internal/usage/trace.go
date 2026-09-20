package usage

// Trace is one fully-captured HTTP exchange through a request meter
// (sidecar trace contract, daemon-owned). Unlike usage.Event — one row per
// MEASURED exchange — a trace exists for every completed exchange,
// metered or not, and carries the raw bodies the event deliberately drops.
//
// Stored spellings are RAW (like events); bodies are verbatim up to the
// per-side cap with truncation flags. Auth material is never persisted:
// headers are not stored at all, and secret query params are redacted
// from the stored path (relay is untouched).
type Trace struct {
	ID           string `json:"id"`
	Timestamp    int64  `json:"timestamp"`
	Vendor       string `json:"vendor"`
	Model        string `json:"model"`
	Method       string `json:"method"`
	Path         string `json:"path"`
	StatusCode   int    `json:"statusCode"`
	TTFBMs       int64  `json:"ttftMs"`
	DurationMs   int64  `json:"durationMs"`
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	// ErrorClass is always set ("none" default) — the shared taxonomy,
	// so error rollups never need NULL handling.
	ErrorClass string `json:"errorClass"`
	// RetrySuspect marks a raw repeat inside the retry window: the second
	// response may double-count in usage totals.
	RetrySuspect bool   `json:"retrySuspect"`
	RequestHash  string `json:"requestHash"`
	// Bodies are UTF-8-safe prefixes capped at traceBodyCapBytes; the
	// *Bytes fields carry the full on-wire sizes.
	RequestBody       string `json:"requestBody,omitempty"`
	ResponseBody      string `json:"responseBody,omitempty"`
	RequestTruncated  bool   `json:"requestTruncated,omitempty"`
	ResponseTruncated bool   `json:"responseTruncated,omitempty"`
	RequestBytes      int    `json:"requestBytes"`
	ResponseBytes     int    `json:"responseBytes"`
}

// TraceSummary is the list view: everything except the bodies.
type TraceSummary struct {
	ID                string `json:"id"`
	Timestamp         int64  `json:"timestamp"`
	Vendor            string `json:"vendor"`
	Model             string `json:"model"`
	Method            string `json:"method"`
	Path              string `json:"path"`
	StatusCode        int    `json:"statusCode"`
	TTFBMs            int64  `json:"ttftMs"`
	DurationMs        int64  `json:"durationMs"`
	InputTokens       int64  `json:"inputTokens"`
	OutputTokens      int64  `json:"outputTokens"`
	ErrorClass        string `json:"errorClass"`
	RetrySuspect      bool   `json:"retrySuspect"`
	RequestHash       string `json:"requestHash"`
	RequestTruncated  bool   `json:"requestTruncated,omitempty"`
	ResponseTruncated bool   `json:"responseTruncated,omitempty"`
	RequestBytes      int    `json:"requestBytes"`
	ResponseBytes     int    `json:"responseBytes"`
}

// TraceModelStats is one per-(vendor, model) rollup row.
type TraceModelStats struct {
	Vendor       string  `json:"vendor"`
	Model        string  `json:"model"`
	Requests     int     `json:"requests"`
	Errors       int     `json:"errors"`
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	AvgTTFBMs    float64 `json:"avgTtftMs"`
	AvgTokPerSec float64 `json:"avgTokPerSec"`
}

// TraceStats is the /proxy/stats window aggregate.
type TraceStats struct {
	WindowHours   int               `json:"windowHours"`
	Since         int64             `json:"since"`
	Requests      int               `json:"requests"`
	Errors        int               `json:"errors"`
	ErrorRate     float64           `json:"errorRate"`
	RetrySuspects int               `json:"retrySuspects"`
	AvgTTFBMs     float64           `json:"avgTtftMs"`
	AvgTokPerSec  float64           `json:"avgTokPerSec"`
	ByModel       []TraceModelStats `json:"byModel"`
}
