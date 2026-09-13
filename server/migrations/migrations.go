// Package migrations embeds the schema migrations so cmd/migrate runs
// without a source checkout layout (embed patterns cannot escape the
// package directory, hence this shim next to the SQL).
package migrations

import "embed"

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
