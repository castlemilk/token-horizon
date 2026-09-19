package platform

// Daemon configuration: reads the SAME files the Swift core uses so both
// daemons coexist over one config dir during the migration, and the Go
// daemon is a drop-in once parity is reached.
//
//   <configDir>/settings.json        capture methodology + polling prefs
//   <configDir>/cloud-identity.json  UI-signed-in cloud identity (0600)
//   <configDir>/machine-id           persisted UUID (created on first run)
//   <configDir>/machine-alias        display alias override
//   <configDir>/canonical.json       user vendor/model fold overrides
//
// Config dir: $XDG_CONFIG_HOME/token-horizon or ~/.config/token-horizon on
// every platform (macOS keeps the XDG-style path — see MacOSPaths).

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Capture methodology — the operator's choice of usage source:
//
//	point  loopback request meters count usage (default; corporate-safe)
//	mitm   scoped TLS interception counts usage (consent-gated)
//	files  provider session FILES count usage (selfReported) — main's
//	       legacy school of thought, now a mode instead of hardcoded
//
// point and mitm ALWAYS run file annotation (files contribute tool labels,
// reported cost and limit snapshots — they just never create usage rows).
const (
	MethodologyPoint = "point"
	MethodologyMITM  = "mitm"
	MethodologyFiles = "files"
)

type Settings struct {
	// CaptureMethodology is the single knob. Back-compat: absent → derived
	// from the legacy meterCaptureMode key (point|mitm).
	CaptureMethodology string `json:"captureMethodology"`
	MeterCaptureMode   string `json:"meterCaptureMode"`
	FilePolling        bool   `json:"filePolling"`
	// Per-vendor meter desired state: true = always on, false = off,
	// absent = default.
	MeterToggles map[string]bool `json:"meterToggles"`
}

// FilePollingEnabled: filePolling setting; the files methodology forces it
// on (the scanners ARE the counting source). Env TH_FILE_POLL=1 forces on.
func (s Settings) FilePollingEnabled() bool {
	if s.Methodology() == MethodologyFiles {
		return true
	}
	if os.Getenv("TH_FILE_POLL") == "1" {
		return true
	}
	return s.FilePolling
}

// Methodology resolves the effective capture methodology:
// settings.json captureMethodology > legacy meterCaptureMode > env
// TH_CAPTURE_METHODOLOGY > TH_CAPTURE_MODE > point default.
func (s Settings) Methodology() string {
	m := s.CaptureMethodology
	if m == "" {
		m = s.MeterCaptureMode
	}
	if env := os.Getenv("TH_CAPTURE_METHODOLOGY"); env != "" {
		m = env
	} else if env := os.Getenv("TH_CAPTURE_MODE"); env != "" && m == "" {
		m = env
	}
	switch strings.ToLower(strings.TrimSpace(m)) {
	case MethodologyMITM:
		return MethodologyMITM
	case MethodologyFiles:
		return MethodologyFiles
	default:
		return MethodologyPoint
	}
}

func configDir() string {
	if env := os.Getenv("TH_CONFIG_DIR"); env != "" {
		return env
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "token-horizon")
}

func SettingsPath() string { return filepath.Join(configDir(), "settings.json") }

func loadSettings() Settings {
	var s Settings
	if data, err := os.ReadFile(SettingsPath()); err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

// saveSettings merges into the existing settings.json — the file is shared
// with the Swift core, which owns keys this daemon does not know about
// (alibabaCookie, meterToggles, runtimeEndpoints, ...). Never rewrite
// wholesale.
func SaveSettings(s Settings) error {
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	merged := map[string]any{}
	if data, err := os.ReadFile(SettingsPath()); err == nil {
		_ = json.Unmarshal(data, &merged)
	}
	merged["captureMethodology"] = s.CaptureMethodology
	merged["filePolling"] = s.FilePolling
	data, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(SettingsPath(), data, 0o600); err != nil {
		return err
	}
	return nil
}

// setMethodology persists the operator's capture methodology choice.
func SetMethodology(m string) error {
	s := loadSettings()
	s.CaptureMethodology = m
	return SaveSettings(s)
}

// ---- Cloud identity (daemon-held sign-in; same file as the Swift core) ----

type CloudIdentity struct {
	BaseURL     string  `json:"baseURL"`
	Handle      string  `json:"handle"`
	UserID      string  `json:"userID"`
	Team        string  `json:"team"`
	DisplayName string  `json:"displayName"`
	AvatarURL   string  `json:"avatarURL"`
	SavedAt     float64 `json:"savedAt"`
}

func CloudIdentityPath() string { return filepath.Join(configDir(), "cloud-identity.json") }

func LoadCloudIdentity() *CloudIdentity {
	data, err := os.ReadFile(CloudIdentityPath())
	if err != nil {
		return nil
	}
	var id CloudIdentity
	if json.Unmarshal(data, &id) != nil {
		return nil
	}
	return &id
}

func SaveCloudIdentity(id *CloudIdentity) error {
	if id.SavedAt <= 0 {
		id.SavedAt = float64(time.Now().Unix())
	}
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(id)
	if err != nil {
		return err
	}
	return os.WriteFile(CloudIdentityPath(), data, 0o600)
}

func ClearCloudIdentity() { _ = os.Remove(CloudIdentityPath()) }

// ---- Machine identity (same files as the Swift core) ----

func machineID() string {
	path := filepath.Join(configDir(), "machine-id")
	if data, err := os.ReadFile(path); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	id := NewUUID()
	_ = os.MkdirAll(configDir(), 0o755)
	_ = os.WriteFile(path, []byte(id), 0o600)
	return id
}

func machineAlias() string {
	if env := os.Getenv("TH_MACHINE_ALIAS"); env != "" {
		return env
	}
	if data, err := os.ReadFile(filepath.Join(configDir(), "machine-alias")); err == nil {
		if a := strings.TrimSpace(string(data)); a != "" {
			return a
		}
	}
	host, _ := os.Hostname()
	// Sanitize like the Swift side: strip domain, keep short hostname.
	if i := strings.IndexByte(host, '.'); i > 0 {
		host = host[:i]
	}
	return host
}

// ---- Exported accessors for sibling packages ----

// ConfigDir is the shared token-horizon config directory.
func ConfigDir() string { return configDir() }

// MachineID is the persisted per-machine UUID.
func MachineID() string { return machineID() }

// MachineAlias is the display alias (TH_MACHINE_ALIAS > file > hostname).
func MachineAlias() string { return machineAlias() }

// LoadSettings reads settings.json (shared with the Swift core).
func LoadSettings() Settings { return loadSettings() }

// ConsentGranted mirrors ConsentManager.isGranted: TH_CONSENT env grants
// (comma-separated scopes, no wildcard) OR a consents.json record with
// granted=true and version == consentVersion. Nothing listens without it.
const consentVersion = 1

func ConsentGranted(scope string) bool {
	if env := os.Getenv("TH_CONSENT"); env != "" {
		for _, s := range strings.Split(env, ",") {
			if strings.TrimSpace(s) == scope {
				return true
			}
		}
	}
	data, err := os.ReadFile(filepath.Join(configDir(), "consents.json"))
	if err != nil {
		return false
	}
	var records map[string]struct {
		Granted bool `json:"granted"`
		Version int  `json:"version"`
	}
	if json.Unmarshal(data, &records) != nil {
		return false
	}
	r, ok := records[scope]
	return ok && r.Granted && r.Version == consentVersion
}

func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return strings.ToUpper(fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]))
}

func HomeDir() string {
	h, _ := os.UserHomeDir()
	return h
}

func EnvOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
