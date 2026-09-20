// Command migrate applies the schema migrations in order, tracking them
// in schema_migrations (re-runs are no-ops). The server also runs this on
// boot — this command stays for explicit control (provisioning, CI).
//
// Usage:
//
//	go run ./cmd/migrate --driver postgres --dsn 'postgres://u:p@host/db?sslmode=disable'
//	go run -tags duckdb ./cmd/migrate --driver duckdb --dsn /var/lib/th/cloud.duckdb
//	go run ./cmd/migrate --config server.json   (driver/dsn from the config file)
package main

import (
	"database/sql"
	"flag"
	"log"
	"os"

	_ "github.com/lib/pq"

	"github.com/castlemilk/token-horizon/cloud/server/migrations"
	"github.com/castlemilk/token-horizon/cloud/server/src/config"
)

func main() {
	logger := log.New(os.Stderr, "th-migrate: ", log.LstdFlags)
	driverFlag := flag.String("driver", "", "postgres | duckdb (overrides config)")
	dsnFlag := flag.String("dsn", "", "database DSN (overrides config)")
	configPath := flag.String("config", os.Getenv("TH_SERVER_CONFIG"), "JSON config file (default ./server.json when present)")
	flag.Parse()
	cfg, err := config.Load(*configPath)
	if err != nil {
		logger.Fatal(err)
	}
	driver, dsn := cfg.Driver, cfg.DSN
	if *driverFlag != "" {
		driver = *driverFlag
	}
	if *dsnFlag != "" {
		dsn = *dsnFlag
	}
	if dsn == "" {
		logger.Fatal("--dsn is required (or set dsn in the config file)")
	}
	switch driver {
	case "postgres", "duckdb":
	default:
		logger.Fatalf("unknown driver %q", driver)
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		logger.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		logger.Fatal(err)
	}
	if err := migrations.Apply(db, driver, logger); err != nil {
		logger.Fatal(err)
	}
}
