// Package migrations embeds the schema migrations so cmd/migrate runs
// without a source checkout layout (embed patterns cannot escape the
// package directory, hence this shim next to the SQL).
package migrations

import (
	"database/sql"
	"embed"
	"fmt"
	"log"
	"sort"
)

//go:embed duckdb/*.sql
var DuckDB embed.FS

//go:embed postgres/*.sql
var Postgres embed.FS

// Dir returns the embedded FS and directory name for a driver.
// NOTE: embed paths must not end in "/" — ReadDir("duckdb/") fails
// while ReadDir("duckdb") works.
func Dir(driver string) (embed.FS, string) {
	if driver == "duckdb" {
		return DuckDB, "duckdb"
	}
	return Postgres, "postgres"
}

// Apply runs every unapplied migration for the driver in filename order,
// tracking them in schema_migrations (re-runs are no-ops). Scripts must be
// idempotent. Schema changes are deliberate: the server NEVER auto-applies —
// cmd/migrate is the only runner (boot, CI, provisioning all invoke it).
func Apply(db *sql.DB, driver string, logger *log.Logger) error {
	dir, prefix := Dir(driver)
	files, err := dir.ReadDir(prefix)
	if err != nil {
		return err
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
			if logger != nil {
				logger.Printf("%s: already applied, skip", version)
			}
			continue
		case err != sql.ErrNoRows:
			// schema_migrations itself missing on a fresh DB — create it.
			if _, cerr := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
				version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); cerr != nil {
				return cerr
			}
		}
		sqlBytes, err := dir.ReadFile(prefix + "/" + name)
		if err != nil {
			return err
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(sqlBytes)); err != nil {
			tx.Rollback()
			return fmt.Errorf("%s: %w", version, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
			tx.Rollback()
			return fmt.Errorf("%s record: %w", version, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		if logger != nil {
			logger.Printf("%s: applied [%s]", version, driver)
		}
	}
	return nil
}
