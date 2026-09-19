package platform

import "runtime"

var (
	version  = "0.5.0-go-m3"
	platform = runtime.GOOS
)

// Version is the daemon build version (GET /health).
func Version() string { return version }

// Name is the GOOS this daemon was built for (GET /health).
func Name() string { return platform }
