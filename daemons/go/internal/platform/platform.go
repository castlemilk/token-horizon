package platform

import "runtime"

var (
	version  = "0.5.0-go-m3"
	commit   = "dev"
	builtAt  = "unknown"
	platform = runtime.GOOS
)

// BuildInfo is the identity stamped into bundled desktop daemons at build time.
// Its wire shape matches the native app's /health build field.
type BuildInfo struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	BuiltAt string `json:"built_at"`
}

func Build() BuildInfo { return BuildInfo{Version: version, Commit: commit, BuiltAt: builtAt} }

// Version is the daemon build version (GET /health).
func Version() string { return version }

// Name is the GOOS this daemon was built for (GET /health).
func Name() string { return platform }
