// Package config loads the cloud server's optional JSON config file and
// merges it with the environment. Precedence (per key, highest first):
//
//	environment  >  config file  >  built-in default
//
// so a committed server.json pins the deployment (e.g. driver=duckdb
// today, driver=postgres later — the swap is a one-line edit plus
// re-running cmd/migrate against the new DSN) while env vars still
// override for one-off runs and secrets injection.
//
// Resolution of the file itself: --config flag > $TH_SERVER_CONFIG >
// ./server.json when present. A missing explicit path is an error; a
// missing default file is silently skipped.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// OAuth holds one provider's client credentials.
type OAuth struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
}

// Config is the full server configuration surface (mirrors the TH_SERVER_*
// env vars one-to-one).
type Config struct {
	// Driver is the database/sql driver: "postgres" (default) or
	// "duckdb" (requires the duckdb build tag at compile time).
	Driver    string `json:"driver"`
	DSN       string `json:"dsn"`
	Addr      string `json:"addr"`
	SyncToken string `json:"syncToken"`
	PublicURL string `json:"publicUrl"`
	DataDir   string `json:"dataDir"`
	// CORSOrigins lists browser origins allowed cross-origin (vite dev
	// server, Tauri webview). "*" reflects any origin (dev only).
	CORSOrigins []string `json:"corsOrigins"`
	Google      OAuth    `json:"google"`
	Microsoft   OAuth    `json:"microsoft"`
}

// Defaults returns the built-in fallback configuration.
func Defaults() Config {
	return Config{
		Driver:    "postgres",
		Addr:      ":8080",
		PublicURL: "http://localhost:8080",
		DataDir:   "./data",
		CORSOrigins: []string{
			"http://127.0.0.1:5173", "http://localhost:5173", // vite dev
			"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
		},
	}
}

// DefaultPath is the implicit config file used when neither --config nor
// TH_SERVER_CONFIG points anywhere.
const DefaultPath = "server.json"

// LoadFile reads one JSON config file; a missing file yields the defaults
// and no error only when path == DefaultPath (implicit lookup).
func LoadFile(path string) (Config, error) {
	cfg := Defaults()
	if path == "" {
		path = DefaultPath
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) && path == DefaultPath {
			return cfg, nil
		}
		return cfg, fmt.Errorf("read config %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config %s: %w", path, err)
	}
	return cfg, nil
}

// MergeEnv applies TH_SERVER_*/GOOGLE_*/MS_* overrides on top of cfg.
func (c Config) MergeEnv() Config {
	if v := os.Getenv("TH_SERVER_DRIVER"); v != "" {
		c.Driver = v
	}
	if v := os.Getenv("TH_SERVER_DSN"); v != "" {
		c.DSN = v
	}
	if v := os.Getenv("TH_SERVER_ADDR"); v != "" {
		c.Addr = v
	}
	if v := os.Getenv("TH_SYNC_TOKEN"); v != "" {
		c.SyncToken = v
	}
	if v := os.Getenv("TH_SERVER_PUBLIC_URL"); v != "" {
		c.PublicURL = v
	}
	if v := os.Getenv("TH_SERVER_DATA"); v != "" {
		c.DataDir = v
	}
	if v := os.Getenv("TH_SERVER_CORS_ORIGINS"); v != "" {
		var origins []string
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		c.CORSOrigins = origins
	}
	if v := os.Getenv("GOOGLE_CLIENT_ID"); v != "" {
		c.Google.ClientID = v
	}
	if v := os.Getenv("GOOGLE_CLIENT_SECRET"); v != "" {
		c.Google.ClientSecret = v
	}
	if v := os.Getenv("MS_CLIENT_ID"); v != "" {
		c.Microsoft.ClientID = v
	}
	if v := os.Getenv("MS_CLIENT_SECRET"); v != "" {
		c.Microsoft.ClientSecret = v
	}
	return c
}

// Load is LoadFile + MergeEnv: the effective configuration.
func Load(path string) (Config, error) {
	cfg, err := LoadFile(path)
	if err != nil {
		return cfg, err
	}
	return cfg.MergeEnv(), nil
}
