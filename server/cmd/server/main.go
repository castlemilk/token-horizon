// Command server runs the token-horizon cloud ingest + sync API.
//
// Env:
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
// Point a daemon at it with TH_SYNC_URL=http://host:8080.
package main

import (
	"log"
	"net/http"
	"os"
	"time"

	_ "github.com/lib/pq"

	api "github.com/castlemilk/token-horizon/server/src/interfaces/http"
	"github.com/castlemilk/token-horizon/server/src/interfaces/store/sqlstore"
	"github.com/castlemilk/token-horizon/server/src/use_cases/account"
	"github.com/castlemilk/token-horizon/server/src/use_cases/auth"
	"github.com/castlemilk/token-horizon/server/src/use_cases/follows"
	"github.com/castlemilk/token-horizon/server/src/use_cases/ingest"
	"github.com/castlemilk/token-horizon/server/src/use_cases/leaderboard"
	syncuc "github.com/castlemilk/token-horizon/server/src/use_cases/sync"
	"github.com/castlemilk/token-horizon/server/src/use_cases/teams"
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
			ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		},
		Microsoft: auth.OAuthConfig{
			ClientID:     os.Getenv("MS_CLIENT_ID"),
			ClientSecret: os.Getenv("MS_CLIENT_SECRET"),
		},
		PublicURL: getenv("TH_SERVER_PUBLIC_URL", "http://localhost:8080"),
	}
	authUC := auth.Auth{Store: st, Config: authCfg}
	dataDir := getenv("TH_SERVER_DATA", "./data")
	srv := &api.Server{
		Ingest: ingestUC, Sync: syncUC, Board: board, AuthN: authUC, Token: os.Getenv("TH_SYNC_TOKEN"), Log: logger,
		AuthRoutes: &api.Auth{
			Use: authUC, Acct: account.Account{Store: st}, Team: teams.Teams{Store: st},
			Follows: follows.Follows{Store: st}, Board: board,
			AvatarDir:     dataDir + "/avatars",
			AvatarURLBase: "/v1/avatars",
		},
	}
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
