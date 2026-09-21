package meter

// Trace assembly (sidecar /traces contract, daemon-owned). Base-owned like
// everything else in this package: no per-wire-format logic. The meter
// records one trace per completed exchange — metered or not — while
// usage_event keeps counting only measured 2xx rows.
//
// Privacy: headers are never persisted (only bodies), secret query params
// are redacted from the stored path, bodies are capped UTF-8 prefixes.
// The relay itself is untouched.

import (
	"strings"
	"unicode/utf8"

	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
)

// traceBodyCapBytes bounds each stored body side (sidecar parity: 256KB).
// The *Bytes fields always carry the full on-wire sizes.
const traceBodyCapBytes = 256 * 1024

// buildTrace assembles the trace row for a completed exchange. event is nil
// for unmeasured exchanges (non-2xx, unknown paths, truncated bodies) —
// the trace still records status, timing, bodies, and error class. Model
// and token counts come from the event when present, so stored values stay
// byte-identical to what counting used; model falls back to the format's
// raw parse (stored RAW, never canonicalized).
func (m *Meter) buildTrace(x *Exchange, event *usage.Event, fp string, suspect bool) *usage.Trace {
	model := m.Format.Model(x)
	var in, out int64
	if event != nil {
		model, in, out = event.Model, event.Tokens.Input, event.Tokens.Output
	}
	var ttft int64
	if !x.FirstByteAt.IsZero() {
		if d := x.FirstByteAt.Sub(x.StartedAt).Milliseconds(); d > 0 {
			ttft = d
		}
	}
	reqBody, reqTrunc := capUTF8(x.RequestBody, traceBodyCapBytes)
	respBody, respTrunc := capUTF8(x.ResponseBody.Bytes(), traceBodyCapBytes)
	if x.ResponseTruncated {
		respTrunc = true
	}
	return &usage.Trace{
		ID:                x.EventID,
		Timestamp:         x.CompletedAt.Unix(),
		Vendor:            m.Vendor,
		Model:             model,
		Method:            x.Method,
		Path:              redactPath(x.Path),
		StatusCode:        x.Status,
		TTFBMs:            ttft,
		DurationMs:        x.DurationMs(),
		InputTokens:       in,
		OutputTokens:      out,
		ErrorClass:        x.ErrorClass,
		RetrySuspect:      suspect,
		RequestHash:       fp,
		RequestBody:       reqBody,
		ResponseBody:      respBody,
		RequestTruncated:  reqTrunc,
		ResponseTruncated: respTrunc,
		RequestBytes:      len(x.RequestBody),
		ResponseBytes:     x.ResponseBytes,
	}
}

// capUTF8 cuts b to a valid-UTF-8 prefix of at most cap bytes. A trailing
// split rune backs off (at most 3 bytes — the longest UTF-8 sequence).
func capUTF8(b []byte, cap int) (string, bool) {
	if len(b) <= cap {
		return string(b), false
	}
	s := string(b[:cap])
	for i := 0; i < 4 && len(s) > 0; i++ {
		if r, _ := utf8.DecodeLastRuneInString(s); r != utf8.RuneError {
			break
		}
		s = s[:len(s)-1]
	}
	return s, true
}

// secretQueryKeys blanks values that smell like credentials in the STORED
// path (relay untouched). Exact or _/-suffixed match, so "monkey" survives
// but "access_token" and "api-key" don't.
var secretQueryKeys = []string{"key", "api_key", "apikey", "token", "auth", "secret", "session", "sig", "signature"}

func redactPath(path string) string {
	q := strings.IndexByte(path, '?')
	if q < 0 {
		return path
	}
	head, raw := path[:q], path[q+1:]
	parts := strings.Split(raw, "&")
	for i, kv := range parts {
		name := kv
		if j := strings.IndexByte(kv, '='); j >= 0 {
			name = kv[:j]
		}
		lower := strings.ToLower(name)
		for _, sk := range secretQueryKeys {
			if lower == sk || strings.HasSuffix(lower, "_"+sk) || strings.HasSuffix(lower, "-"+sk) {
				if j := strings.IndexByte(kv, '='); j >= 0 {
					parts[i] = kv[:j+1] + "REDACTED"
				}
				break
			}
		}
	}
	return head + "?" + strings.Join(parts, "&")
}
