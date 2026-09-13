// Command server runs the token-horizon cloud ingest + sync API.
//
// Env:
//
//	TH_SERVER_ADDR   listen address (default :8080)
//	TH_SERVER_DSN    database DSN (required)
//	TH_SERVER_DRIVER database driver: postgres (default) or duckdb
//	                 (duckdb needs -tags duckdb at build time)
//	TH_SYNC_TOKEN    shared bearer token (empty = open, local dev only)
//
// The schema must exist first: go run ./cmd/migrate --driver … --dsn …
// Point a daemon at it with TH_SYNC_URL=http://host:8080.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/lib/pq"

	api "github.com/castlemilk/token-horizon/server/src/interfaces/http"
	"github.com/castlemilk/token-horizon/server/src/interfaces/store"
	usecases "github.com/castlemilk/token-horizon/server/src/use_cases"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	logger := log.New(os.Stderr, "th-cloud: ", log.LstdFlags)
	driver := getenv("TH_SERVER_DRIVER", "postgres")
	dsn := os.Getenv("TH_SERVER_DSN")
	if dsn == "" {
		logger.Fatal("TH_SERVER_DSN is required")
	}
	st, err := store.Open(driver, dsn)
	if err != nil {
		logger.Fatalf("open store (%s): %v (run cmd/migrate first?)", driver, err)
	}
	defer st.Close()

	ingest := usecases.Ingest{Store: st}
	sync := usecases.Sync{Store: st}
	srv := &api.Server{Ingest: ingest, Sync: sync, Token: os.Getenv("TH_SYNC_TOKEN"), Log: logger}
	if srv.Token == "" {
		logger.Print("WARNING: TH_SYNC_TOKEN unset — API is open")
	}

	addr := getenv("TH_SERVER_ADDR", ":8080")
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	logger.Printf("listening on %s (driver=%s)", addr, driver)
	logger.Fatal(httpSrv.ListenAndServe())
}
