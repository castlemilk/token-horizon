package auth

// Vendor credential chains (Providers/Auth/VendorAuth.swift port).
// Composable sources tried in order; first non-empty wins. Raw credentials
// are resolved in memory only — never persisted by the daemon.

import (
	"encoding/base64"
	"encoding/json"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform/keychain"
	"os"
	"path/filepath"
	"strings"
)

// LabeledCredential pairs a profile label (multi-account vendors) with the
// resolved credential.
type LabeledCredential struct {
	Label      string
	Credential string
}

// Source is one place a credential can come from.
type Source interface {
	Resolve() string
	// ResolveLabeled yields every (label, credential) pair the source knows
	// (single-account sources yield one unlabeled entry).
	ResolveLabeled() []LabeledCredential
}

// Chain composes sources; the first non-empty result wins.
type Chain struct{ Sources []Source }

func (c Chain) Resolve() string {
	for _, s := range c.Sources {
		if v := s.Resolve(); v != "" {
			return v
		}
	}
	return ""
}

// ResolveAll collects labeled credentials across the chain, deduped by label.
func (c Chain) ResolveAll() []LabeledCredential {
	var out []LabeledCredential
	seen := map[string]bool{}
	for _, s := range c.Sources {
		for _, lc := range s.ResolveLabeled() {
			if lc.Credential != "" && !seen[lc.Label] {
				seen[lc.Label] = true
				out = append(out, lc)
			}
		}
	}
	return out
}

func home() string {
	h, _ := os.UserHomeDir()
	return h
}

// Expand replaces a leading ~ with the home directory.
func Expand(path string) string {
	if path == "~" {
		return home()
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home(), path[2:])
	}
	return path
}

// ---- sources ----

type envSource struct{ name string }

func Env(name string) Source { return envSource{name} }

func (s envSource) Resolve() string { return os.Getenv(s.name) }
func (s envSource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}

// OpenCodeAuthFileKeys reads opencode's auth.json (OPENCODE_AUTH env or
// ~/.local/share/opencode/auth.json) → provider → key map.
func OpenCodeAuthFileKeys() map[string]string {
	path := os.Getenv("OPENCODE_AUTH")
	if path == "" {
		path = filepath.Join(home(), ".local/share/opencode/auth.json")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var obj map[string]map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return nil
	}
	out := map[string]string{}
	for provider, entry := range obj {
		if key, ok := entry["key"].(string); ok && key != "" {
			out[provider] = key
		}
	}
	return out
}

// OpenCodeAuthEntry returns the raw entry for a provider (object or bare
// token string normalized to {"key": ...}).
func OpenCodeAuthEntry(provider string) map[string]any {
	path := os.Getenv("OPENCODE_AUTH")
	if path == "" {
		path = filepath.Join(home(), ".local/share/opencode/auth.json")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return nil
	}
	if entry, ok := obj[provider].(map[string]any); ok {
		return entry
	}
	if token, ok := obj[provider].(string); ok && token != "" {
		return map[string]any{"key": token}
	}
	return nil
}

type opencodeKeySource struct{ key string }

func OpenCodeKey(key string) Source { return opencodeKeySource{key} }

func (s opencodeKeySource) Resolve() string { return OpenCodeAuthFileKeys()[s.key] }
func (s opencodeKeySource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}

type fileTextSource struct{ path string }

func FileText(path string) Source { return fileTextSource{path} }

func (s fileTextSource) Resolve() string {
	data, err := os.ReadFile(Expand(s.path))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
func (s fileTextSource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}

type fileTextEnvSource struct{ envVar, fallback string }

func FileTextEnv(envVar, fallback string) Source { return fileTextEnvSource{envVar, fallback} }

func (s fileTextEnvSource) Resolve() string {
	path := os.Getenv(s.envVar)
	if strings.TrimSpace(path) == "" {
		path = s.fallback
	}
	return FileText(path).Resolve()
}
func (s fileTextEnvSource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}

// Walk digs a dot-separated key path through nested JSON objects.
func Walk(node any, keyPath string) string {
	current := node
	for _, part := range strings.Split(keyPath, ".") {
		dict, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = dict[part]
	}
	if s, ok := current.(string); ok {
		return s
	}
	return ""
}

type fileJSONSource struct {
	path     string
	keyPaths []string
}

func FileJSON(path string, keyPaths ...string) Source {
	return fileJSONSource{path, keyPaths}
}

func (s fileJSONSource) Resolve() string {
	data, err := os.ReadFile(Expand(s.path))
	if err != nil {
		return ""
	}
	var obj any
	if json.Unmarshal(data, &obj) != nil {
		return ""
	}
	for _, kp := range s.keyPaths {
		if v := Walk(obj, kp); v != "" {
			return v
		}
	}
	return ""
}
func (s fileJSONSource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}

// Keychain is macOS-only; stubbed empty elsewhere (Linux port reads the
// same on-disk credential files the tools write, which is how Linux users
// authenticate anyway).
type keychainSource struct {
	service, account string
	keyPaths         []string
	base64JSON       bool
}

func Keychain(service string, keyPaths ...string) Source {
	return keychainSource{service: service, keyPaths: keyPaths}
}
func KeychainBase64JSON(service, account string, keyPaths ...string) Source {
	return keychainSource{service: service, account: account, keyPaths: keyPaths, base64JSON: true}
}

func (s keychainSource) Resolve() string {
	secret := keychain.Read(s.service, s.account)
	if secret == "" {
		return ""
	}
	if s.base64JSON {
		secret = strings.TrimPrefix(secret, "go-keyring-base64:")
		decoded, err := base64.StdEncoding.DecodeString(secret)
		if err != nil {
			return ""
		}
		var obj map[string]any
		if json.Unmarshal(decoded, &obj) != nil {
			return ""
		}
		if token, ok := obj["token"].(map[string]any); ok {
			obj = token
		}
		for _, kp := range s.keyPaths {
			if v := Walk(obj, kp); v != "" {
				return v
			}
		}
		return ""
	}
	if len(s.keyPaths) == 0 {
		return secret
	}
	var obj any
	if json.Unmarshal([]byte(secret), &obj) != nil {
		return ""
	}
	for _, kp := range s.keyPaths {
		if v := Walk(obj, kp); v != "" {
			return v
		}
	}
	return ""
}
func (s keychainSource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}

type customSource struct{ read func() string }

func Custom(read func() string) Source { return customSource{read} }

func (s customSource) Resolve() string { return s.read() }
func (s customSource) ResolveLabeled() []LabeledCredential {
	if v := s.Resolve(); v != "" {
		return []LabeledCredential{{Credential: v}}
	}
	return nil
}
