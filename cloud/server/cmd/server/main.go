// Command server runs the token-horizon cloud ingest + sync API.
//
// Config: optional JSON file (see server.example.json) — resolution
// --config flag > $TH_SERVER_CONFIG > ./server.json when present. Every
// key has an env equivalent that overrides the file per-key:
//
//	TH_SERVER_ADDR   listen address (default :8080)
//	TH_SERVER_DSN    database DSN (required)
//	TH_SERVER_DRIVER database driver: postgres (default) or duckdb
//	                 (duckdb needs -tags duckdb at build time)
//	TH_SYNC_TOKEN    shared bearer token (empty = open, local dev only)
//	TH_SERVER_PUBLIC_URL public base URL for OAuth callbacks
//	                 (default http://localhost:8080)
//	GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — Google login
//	MS_CLIENT_ID / MS_CLIENT_SECRET         — Microsoft login
//	TH_SERVER_DATA   avatar storage dir (default ./data)
//
// The schema must exist first: go run ./cmd/migrate --driver … --dsn …
// (migrations are NEVER auto-applied — schema changes are a deliberate,
// operator-run step). Point a daemon at it with TH_SYNC_URL=http://host:8080.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/lib/pq"

	"github.com/castlemilk/token-horizon/cloud/server/src/config"
	api "github.com/castlemilk/token-horizon/cloud/server/src/interfaces/http"
	"github.com/castlemilk/token-horizon/cloud/server/src/interfaces/store/sqlstore"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/account"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/auth"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/follows"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/ingest"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/leaderboard"
	syncuc "github.com/castlemilk/token-horizon/cloud/server/src/use_cases/sync"
	"github.com/castlemilk/token-horizon/cloud/server/src/use_cases/teams"
)

func main() {
	logger := log.New(os.Stderr, "th-cloud: ", log.LstdFlags)
	configPath := flag.String("config", os.Getenv("TH_SERVER_CONFIG"), "JSON config file (default ./server.json when present)")
	flag.Parse()
	cfg, err := config.Load(*configPath)
	if err != nil {
		logger.Fatal(err)
	}
	driver, dsn := cfg.Driver, cfg.DSN
	if dsn == "" {
		logger.Fatal("database DSN is required (config dsn or TH_SERVER_DSN)")
	}
	st, err := sqlstore.Open(driver, dsn)
	if err != nil {
		logger.Fatalf("open store (%s): %v (run cmd/migrate first?)", driver, err)
	}
	defer st.Close()

	ingestUC := ingest.Ingest{Store: st}
	syncUC := syncuc.Sync{Store: st}
	board := &leaderboard.Leaderboard{Store: st}
	authCfg := auth.AuthConfig{
		Google: auth.OAuthConfig{
			ClientID:     cfg.Google.ClientID,
			ClientSecret: cfg.Google.ClientSecret,
		},
		Microsoft: auth.OAuthConfig{
			ClientID:     cfg.Microsoft.ClientID,
			ClientSecret: cfg.Microsoft.ClientSecret,
		},
		PublicURL: cfg.PublicURL,
	}
	authUC := auth.Auth{Store: st, Config: authCfg}
	srv := &api.Server{
		Ingest: ingestUC, Sync: syncUC, Board: board, AuthN: authUC, Token: cfg.SyncToken, Log: logger,
		Store:       st,
		CORSOrigins: cfg.CORSOrigins,
		AuthRoutes: &api.Auth{
			Use: authUC, Acct: account.Account{Store: st}, Team: teams.Teams{Store: st},
			Follows: follows.Follows{Store: st}, Board: board,
			AvatarDir:     cfg.DataDir + "/avatars",
			AvatarURLBase: "/v1/avatars",
		},
	}
	if srv.Token == "" {
		logger.Print("WARNING: TH_SYNC_TOKEN unset — API is open")
	}

	addr := cfg.Addr
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	logger.Printf("listening on %s (driver=%s)", addr, driver)
	logger.Fatal(httpSrv.ListenAndServe())
}
