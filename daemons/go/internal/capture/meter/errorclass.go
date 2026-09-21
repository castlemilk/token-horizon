package meter

// Shared error taxonomy, ported from the gateway sidecar's ClassifyError
// (gateway/usage.go). Pure function: class vocabulary is IDENTICAL to the
// sidecar's ("none", "auth", "rateLimited", ...) so trace-side and
// meter-side diagnostics stay comparable.
//
// Unlike the sidecar, the meter never stores the message — error rows are
// never written to usage_event (counting semantics stay untouched), so only
// the class is kept, aggregated per meter and surfaced via GET /meters.
// Redirects (3xx) are deliberately NOT classified: with the no-follow
// policy they are provider control flow, not failures.

import (
	"bytes"
	"strings"
)

// Error classes (gateway vocabulary, do not rename unilaterally).
const (
	errNone          = "none"
	errAuth          = "auth"
	errRateLimited   = "rateLimited"
	errOverloaded    = "overloaded"
	errContextLength = "contextLength"
	errBadRequest    = "badRequest"
	errServerError   = "serverError"
	errNetwork       = "network"
	errCancelled     = "cancelled"
	errUnknown       = "unknown"
)

// classifyError maps a completed (or failed) exchange to an error class.
// networkErr is the client.Do error text ("" when the upstream answered).
func classifyError(statusCode int, responseBody []byte, networkErr string) string {
	if networkErr != "" {
		lower := strings.ToLower(networkErr)
		if strings.Contains(lower, "cancelled") || strings.Contains(lower, "canceled") {
			return errCancelled
		}
		return errNetwork
	}
	probe := errorProbe(responseBody)
	code, msgLower := "", ""
	if errVal, ok := probe["error"]; ok {
		switch v := errVal.(type) {
		case map[string]any:
			if c, _ := v["code"].(string); c != "" {
				code = strings.ToLower(c)
			} else if t, _ := v["type"].(string); t != "" {
				code = strings.ToLower(t)
			}
			if m, _ := v["message"].(string); m != "" {
				msgLower = strings.ToLower(m)
			} else if code != "" {
				msgLower = code
			}
		case string:
			code = strings.ToLower(v)
			msgLower = code
		}
	}
	if statusCode < 200 || statusCode >= 300 {
		switch {
		case statusCode == 401 || statusCode == 403:
			return errAuth
		case statusCode == 404 || statusCode == 408 || statusCode == 409:
			return errBadRequest
		case statusCode == 429:
			return errRateLimited
		case statusCode == 529:
			return errOverloaded
		case statusCode >= 500:
			if strings.Contains(code, "overloaded") {
				return errOverloaded
			}
			return errServerError
		}
	} else if code == "" {
		return errNone
	}
	switch {
	case strings.Contains(code, "context_length") || strings.Contains(code, "context-length") ||
		strings.Contains(code, "max_tokens") || strings.Contains(code, "too_many_tokens") ||
		strings.Contains(msgLower, "context length"):
		return errContextLength
	case strings.Contains(code, "rate_limit") || strings.Contains(code, "rate-limited") ||
		strings.Contains(code, "429"):
		return errRateLimited
	case strings.Contains(code, "overloaded") || strings.Contains(code, "529") ||
		strings.Contains(code, "capacity"):
		return errOverloaded
	case strings.Contains(code, "invalid_api_key") || strings.Contains(code, "authentication") ||
		strings.Contains(code, "unauthorized") || strings.Contains(code, "permission"):
		return errAuth
	}
	if code == "" {
		if statusCode == 0 {
			return errUnknown
		}
		return errUnknown
	}
	if statusCode >= 400 {
		return errBadRequest
	}
	return errUnknown
}

// errorProbe finds the error object: whole-body JSON first, then the first
// SSE/NDJSON object carrying an "error" key (same shape the sidecar scans).
func errorProbe(responseBody []byte) map[string]any {
	trimmed := bytes.TrimSpace(responseBody)
	if len(trimmed) > 0 {
		var probe map[string]any
		if jsonUnmarshal(trimmed, &probe) == nil && probe != nil {
			return probe
		}
		for _, obj := range sseObjects(string(trimmed)) {
			if _, ok := obj["error"]; ok {
				return obj
			}
		}
		var ndjson map[string]any
		for _, line := range strings.Split(string(trimmed), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var obj map[string]any
			if jsonUnmarshal([]byte(line), &obj) == nil {
				if _, ok := obj["error"]; ok {
					return obj
				}
				ndjson = obj
			}
		}
		if ndjson != nil {
			return ndjson
		}
	}
	return map[string]any{}
}
