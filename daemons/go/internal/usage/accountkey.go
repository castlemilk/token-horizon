package usage

// Pseudonymous per-account identity (Usage/AccountKey.swift port):
// vendor + truncated SHA-256 of the credential, namespaced by vendor.
// Stable across restarts and machines, one-way, vendor-scoped. The raw
// credential is never persisted.

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// AccountKey derives "vendor:a3f19c2e7b4d8051" from a credential
// ("Bearer " scheme prefix stripped). Empty input yields "".
func AccountKey(vendor, credential string) string {
	c := strings.TrimSpace(credential)
	if len(c) > 7 && strings.EqualFold(c[:7], "bearer ") {
		c = c[7:]
	}
	if c == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(c))
	return Vendor(vendor) + ":" + hex.EncodeToString(sum[:8])
}

// AccountKeyForHeaders derives the key from meter-observed request headers,
// checking the common credential carriers in order.
func AccountKeyForHeaders(vendor string, headers map[string]string) string {
	for _, name := range []string{"authorization", "x-api-key", "api-key", "x-goog-api-key"} {
		if v := headers[name]; v != "" {
			return AccountKey(vendor, v)
		}
	}
	return ""
}
