//go:build duckdb

package main

// DuckDB driver registration (opt-in: go build -tags duckdb). Kept out of
// the default build: the driver links a ~100MB static lib and slows every
// compile for operators who only run Postgres.
import _ "github.com/duckdb/duckdb-go/v2"
