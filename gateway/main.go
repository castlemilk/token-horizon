package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Build identity, stamped at release time via:
//
//	go build -ldflags "-X main.buildCommit=<sha> -X main.buildAt=<utc>" .
//
// Unstamped dev builds report "dev"/"unknown" — the supervisor and health
// gates compare this against the app's own stamp so a stale sidecar can
// never silently serve a fresh app (or vice versa).
var (
	buildCommit = "dev"
	buildAt     = "unknown"
)

func main() {
	cfg := ConfigFromEnv()
	store := NewStore(cfg.TraceDir)
	metrics := NewMetrics()
	proxy := NewProxyHandler(cfg, store, metrics)

	mux := http.NewServeMux()
	api := &API{cfg: cfg, store: store, metrics: metrics, buildCommit: buildCommit, buildAt: buildAt}
	// Provider read APIs route before the catch-all proxy.
	api.routes(mux)
	proxy.info = api.handleInfo
	mux.Handle("/", proxy)

	ln, port, err := listenLoopback(cfg.Port, 20)
	if err != nil {
		log.Fatalf("gateway: cannot bind loopback 127.0.0.1:%d-%d: %v", cfg.Port, cfg.Port+19, err)
	}
	api.port = port
	api.baseURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	log.Printf("gateway: listening on 127.0.0.1:%d (openai=%s anthropic=%s ollama=%s traces=%s)",
		port, cfg.OpenAIBase, cfg.AnthropicBase, cfg.OllamaBase, cfg.TraceDir)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No Read/WriteTimeout: generations stream for minutes.
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("gateway: serve: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("gateway: shutting down")
	_ = srv.Close()
}

// listenLoopback binds 127.0.0.1 starting at requested, walking forward.
// Loopback-only by construction: the gateway never listens publicly.
func listenLoopback(requested uint16, attempts int) (net.Listener, uint16, error) {
	var err error
	var ln net.Listener
	for i := 0; i < attempts; i++ {
		port := int(requested) + i
		if port > 65535 {
			break
		}
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			return ln, uint16(port), nil
		}
	}
	return nil, 0, err
}
