package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaults(t *testing.T) {
	cfg := Defaults()
	if cfg.Driver != "postgres" || cfg.Addr != ":8080" {
		t.Fatalf("defaults: %+v", cfg)
	}
	if cfg.DSN != "" {
		t.Fatalf("dsn default should be empty (required): %q", cfg.DSN)
	}
}

func TestLoadFileExplicitMissingIsError(t *testing.T) {
	if _, err := LoadFile(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Fatal("explicit missing config should error")
	}
}

func TestLoadFileMissingDefaultIsSilent(t *testing.T) {
	// Implicit lookup in an empty dir: defaults, no error.
	wd, _ := os.Getwd()
	defer os.Chdir(wd)
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Driver != "postgres" {
		t.Fatalf("driver=%q", cfg.Driver)
	}
}

func TestLoadFileParses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.json")
	raw := `{
	  "driver": "duckdb",
	  "dsn": "/var/lib/th/cloud.duckdb",
	  "addr": ":9090",
	  "syncToken": "s3cret",
	  "publicUrl": "https://tokens.example.com",
	  "dataDir": "/var/lib/th/data",
	  "google": {"clientId": "g-id", "clientSecret": "g-secret"},
	  "microsoft": {"clientId": "ms-id"}
	}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Driver != "duckdb" || cfg.DSN != "/var/lib/th/cloud.duckdb" || cfg.Addr != ":9090" {
		t.Fatalf("cfg: %+v", cfg)
	}
	if cfg.SyncToken != "s3cret" || cfg.PublicURL != "https://tokens.example.com" || cfg.DataDir != "/var/lib/th/data" {
		t.Fatalf("cfg: %+v", cfg)
	}
	if cfg.Google.ClientID != "g-id" || cfg.Google.ClientSecret != "g-secret" || cfg.Microsoft.ClientID != "ms-id" {
		t.Fatalf("oauth: %+v %+v", cfg.Google, cfg.Microsoft)
	}
	// Unset file keys keep defaults.
	if cfg.Microsoft.ClientSecret != "" {
		t.Fatalf("ms secret leaked: %+v", cfg.Microsoft)
	}
}

func TestLoadFileInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.json")
	if err := os.WriteFile(path, []byte(`{nope`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadFile(path); err == nil {
		t.Fatal("invalid JSON should error")
	}
}

func TestMergeEnvOverridesFile(t *testing.T) {
	t.Setenv("TH_SERVER_DRIVER", "postgres")
	t.Setenv("TH_SERVER_DSN", "postgres://u:p@h/db")
	t.Setenv("TH_SERVER_ADDR", ":7070")
	t.Setenv("TH_SYNC_TOKEN", "env-token")
	file := Config{Driver: "duckdb", DSN: "/x.duckdb", Addr: ":9090", SyncToken: "file-token"}
	cfg := file.MergeEnv()
	if cfg.Driver != "postgres" || cfg.DSN != "postgres://u:p@h/db" || cfg.Addr != ":7070" || cfg.SyncToken != "env-token" {
		t.Fatalf("env should win: %+v", cfg)
	}
}

func TestMergeEnvLeavesUntouchedKeys(t *testing.T) {
	file := Config{Driver: "duckdb", DSN: "/x.duckdb", PublicURL: "https://tokens.example.com"}
	cfg := file.MergeEnv()
	if cfg.Driver != "duckdb" || cfg.PublicURL != "https://tokens.example.com" {
		t.Fatalf("file values should survive when env unset: %+v", cfg)
	}
}
