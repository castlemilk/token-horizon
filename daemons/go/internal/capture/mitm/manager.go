package mitm

// MitmCaptureManager (Metering/Mitm/MitmCaptureManager port): scoped TLS
// interception of AI VENDOR HOSTS ONLY — every other connection passes
// through undecrypted; the TLS core is delegated to mitmproxy (never
// hand-rolled); requires the dedicated .mitm consent (never auto-granted);
// privileged setup (CA trust, proxy config) is presented as user-run
// remediation steps — never silent sudo.

import (
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

const ListenPort = 9871

// Manager owns the mitmdump subprocess lifecycle.
type Manager struct {
	mu      sync.Mutex
	process *os.Process
	running bool
	Logf    func(format string, args ...any)
}

func NewManager() *Manager { return &Manager{} }

func (m *Manager) log(format string, args ...any) {
	if m.Logf != nil {
		m.Logf(format, args...)
	}
}

func (m *Manager) caDir() string { return filepath.Join(platform.ConfigDir(), "ca") }
func (m *Manager) addonPath() string {
	return filepath.Join(platform.ConfigDir(), "token_horizon_mitm.py")
}
func (m *Manager) caCertPath() string {
	return filepath.Join(m.caDir(), "mitmproxy-ca-cert.pem")
}

// MitmdumpPath: standard locations, then PATH lookup.
func MitmdumpPath() string {
	for _, candidate := range []string{
		"/opt/homebrew/bin/mitmdump", "/usr/local/bin/mitmdump",
		"/usr/bin/mitmdump", filepath.Join(os.Getenv("HOME"), ".local/bin/mitmdump"),
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if p, err := exec.LookPath("mitmdump"); err == nil {
		return p
	}
	return ""
}

func (m *Manager) CAGenerated() bool {
	_, err := os.Stat(m.caCertPath())
	return err == nil
}

// CATrusted: macOS — trust-settings probe; Linux — presence in the system
// bundle. Best-effort; the remediation step is listed either way.
func (m *Manager) CATrusted() bool {
	if !m.CAGenerated() {
		return false
	}
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("security", "find-certificate", "-c", "mitmproxy",
			"/Library/Keychains/System.keychain").CombinedOutput()
		return err == nil && strings.Contains(string(out), "mitmproxy")
	default:
		_, err := os.Stat("/usr/local/share/ca-certificates/mitmproxy.crt")
		return err == nil
	}
}

// Start launches mitmdump with the deployed addon. Consent-gated: never
// starts without the dedicated .mitm scope.
func (m *Manager) Start() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return
	}
	if !platform.ConsentGranted("mitm") {
		m.log("mitm mode selected but .mitm consent not granted — proxy not started (TH_CONSENT=mitm to grant headless)")
		return
	}
	mitmdump := MitmdumpPath()
	if mitmdump == "" {
		m.log("mitm mode selected but mitmproxy is not installed — %s", RemediationInstall())
		return
	}
	if err := os.MkdirAll(m.caDir(), 0o755); err != nil {
		m.log("mitm: cannot create CA dir: %v", err)
		return
	}
	if err := os.WriteFile(m.addonPath(), []byte(Source()), 0o600); err != nil {
		m.log("mitm: cannot deploy addon: %v", err)
		return
	}
	cmd := exec.Command(mitmdump,
		"--listen-host", "127.0.0.1",
		"--listen-port", strconv.Itoa(ListenPort),
		"--scripts", m.addonPath(),
		"--set", "confdir="+m.caDir(),
		"--quiet")
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		m.log("mitm: failed to launch mitmdump: %v", err)
		return
	}
	m.process = cmd.Process
	m.running = true
	go func() {
		cmd.Wait()
		m.mu.Lock()
		m.running = false
		m.process = nil
		m.mu.Unlock()
	}()
	m.log("mitm: scoped proxy started on 127.0.0.1:%d — AI vendor hosts only", ListenPort)
}

func (m *Manager) Stop() {
	m.mu.Lock()
	p := m.process
	m.process = nil
	m.running = false
	m.mu.Unlock()
	if p != nil {
		p.Kill()
	}
}

func (m *Manager) IsRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

// Status: setup checklist for GET /meters — every step the user must take,
// with the exact command. Nothing privileged happens silently.
func (m *Manager) Status() map[string]any {
	consented := platform.ConsentGranted("mitm")
	var steps []string
	if !consented {
		steps = append(steps, "grant consent: TH_CONSENT=mitm (or approve the prompt)")
	}
	if MitmdumpPath() == "" {
		steps = append(steps, RemediationInstall())
	}
	if MitmdumpPath() != "" && !m.CAGenerated() {
		steps = append(steps, "start the proxy once to generate its CA (happens automatically on start)")
	}
	if m.CAGenerated() && !m.CATrusted() {
		steps = append(steps, RemediationTrust(m.caCertPath()))
	}
	var mitmdump any
	if p := MitmdumpPath(); p != "" {
		mitmdump = p
	}
	if steps == nil {
		steps = []string{}
	}
	return map[string]any{
		"mode":         "mitm",
		"consented":    consented,
		"mitmdump":     mitmdump,
		"running":      m.IsRunning(),
		"listen":       "127.0.0.1:" + strconv.Itoa(ListenPort),
		"ca_generated": m.CAGenerated(),
		"ca_trusted":   m.CATrusted(),
		"scope":        "AI vendor API hosts only; all other TLS passes through undecrypted",
		"next_steps":   steps,
	}
}

func RemediationInstall() string {
	if runtime.GOOS == "darwin" {
		return "install mitmproxy: brew install mitmproxy"
	}
	return "install mitmproxy: see https://mitmproxy.org (e.g. pipx install mitmproxy)"
}

func RemediationTrust(caCert string) string {
	if runtime.GOOS == "darwin" {
		return "trust the CA (admin prompt): sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"" + caCert + "\""
	}
	return "trust the CA: sudo cp \"" + caCert + "\" /usr/local/share/ca-certificates/mitmproxy.crt && sudo update-ca-certificates"
}
