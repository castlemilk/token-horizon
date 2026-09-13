// Command migrate applies the schema migrations in order, tracking them
// in schema_migrations (re-runs are no-ops).
//
// Usage:
//
//	go run ./cmd/migrate --driver postgres --dsn 'postgres://u:p@host/db?sslmode=disable'
//	go run -tags duckdb ./cmd/migrate --driver duckdb --dsn /var/lib/th/cloud.duckdb
package main

import (
	"database/sql"
	"flag"
	"log"
	"os"
	"sort"

	_ "github.com/lib/pq"

	"github.com/castlemilk/token-horizon/server/migrations"
)

func main() {
	logger := log.New(os.Stderr, "th-migrate: ", log.LstdFlags)
	driver := flag.String("driver", "postgres", "postgres | duckdb")
	dsn := flag.String("dsn", "", "database DSN")
	flag.Parse()
	if *dsn == "" {
		logger.Fatal("--dsn is required")
	}
	dir, prefix := migrations.Dir(*driver)
	switch *driver {
	case "postgres", "duckdb":
	default:
		logger.Fatalf("unknown driver %q", *driver)
	}
	db, err := sql.Open(*driver, *dsn)
	if err != nil {
		logger.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		logger.Fatal(err)
	}

	files, err := dir.ReadDir(prefix)
	if err != nil {
		logger.Fatal(err)
	}
	var names []string
	for _, f := range files {
		if !f.IsDir() {
			names = append(names, f.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		version := name
		var exists bool
		err := db.QueryRow(`SELECT true FROM schema_migrations WHERE version = $1`, version).Scan(&exists)
		switch {
		case err == nil:
			logger.Printf("%s: already applied, skip", version)
			continue
		case err != sql.ErrNoRows:
			// schema_migrations itself missing on a fresh DB — create it.
			if _, cerr := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
				version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); cerr != nil {
				logger.Fatal(cerr)
			}
		}
		sqlBytes, err := dir.ReadFile(prefix + "/" + name)
		if err != nil {
			logger.Fatal(err)
		}
		tx, err := db.Begin()
		if err != nil {
			logger.Fatal(err)
		}
		if _, err := tx.Exec(string(sqlBytes)); err != nil {
			tx.Rollback()
			logger.Fatalf("%s: %v", version, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
			tx.Rollback()
			logger.Fatalf("%s record: %v", version, err)
		}
		if err := tx.Commit(); err != nil {
			logger.Fatal(err)
		}
		logger.Printf("%s: applied", version)
	}
}
