package meter

// Shared retry-suspect detection, ported from the gateway sidecar's
// request-hash window (gateway/store.go: RetryWindow) into the meter base
// so every wire format gets it with zero per-provider logic.
//
// Deliberate difference from the sidecar: the fingerprint hashes the RAW
// request bytes (method + path + body) with NO JSON normalization. Stored
// data stays raw everywhere in this codebase (canonicalization is
// read-time only), and an exact byte-repeat is the precise signal for
// "the client sent this twice" — semantically-equal-but-reordered bodies
// are a different request on the wire.
//
// Window and verdicts are in-memory only (meters are long-lived relays;
// restart clears the window). Suspect event IDs are kept in a bounded ring
// for follow-up via GET /analytics/events?id=.

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

// retryWindow is the sidecar's 10-minute repeat window.
const retryWindowSeconds = 10 * 60

// retryWindowCap bounds the hash table (stale-first sweep, then arbitrary
// eviction — order doesn't matter for a correctness window).
const retryWindowCap = 10000

// suspectRingCap bounds remembered suspect event IDs per meter.
const suspectRingCap = 100

type retryWindow struct {
	mu   sync.Mutex
	seen map[string][]int64
}

func newRetryWindow() *retryWindow {
	return &retryWindow{seen: map[string][]int64{}}
}

// requestFingerprint hashes the raw request envelope. No JSON parsing, no
// field stripping — byte-identical repeats hash identically.
func requestFingerprint(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{'\n'})
	h.Write([]byte(path))
	h.Write([]byte{'\n'})
	h.Write(body)
	sum := h.Sum(nil)
	return hex.EncodeToString(sum)[:16]
}

// note records one metered request hash at nowUnix and reports whether the
// same hash was seen inside the window (i.e. this request is a retry
// suspect). Callers record only metered exchanges so the window tracks
// counted traffic, not relay noise.
func (w *retryWindow) note(hash string, nowUnix int64) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	cutoff := nowUnix - retryWindowSeconds
	suspect := false
	kept := w.seen[hash][:0]
	for _, ts := range w.seen[hash] {
		if ts >= cutoff {
			kept = append(kept, ts)
		}
	}
	if len(kept) > 0 {
		suspect = true
	}
	w.seen[hash] = append(kept, nowUnix)
	// Enforce the cap (amortized: only when over). Sweep stale first,
	// then evict arbitrary entries — order doesn't matter for a
	// correctness window, only boundedness does.
	if len(w.seen) > retryWindowCap {
		for h, stamps := range w.seen {
			live := stamps[:0]
			for _, ts := range stamps {
				if ts >= cutoff {
					live = append(live, ts)
				}
			}
			if len(live) == 0 {
				delete(w.seen, h)
			} else {
				w.seen[h] = live
			}
			if len(w.seen) <= retryWindowCap {
				break
			}
		}
		for h := range w.seen {
			if len(w.seen) <= retryWindowCap {
				break
			}
			delete(w.seen, h)
		}
	}
	return suspect
}
