package vendors

// Per-vendor quota adapters (Providers/<Vendor>/*Limits.swift ports).
// One Fetch() per vendor; auth chains come from internal/auth. Registered
// in DefaultAdapters(); the Plan registry supplies caching, refresh,
// last-good retention and snapshot recording.

import (
	"path/filepath"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"github.com/castlemilk/token-horizon/daemons/go/internal/usage"
)

func configPath(name string) string { return filepath.Join(platform.ConfigDir(), name) }

func accountKeyFor(vendor, credential string) string {
	return usage.AccountKey(vendor, credential)
}
