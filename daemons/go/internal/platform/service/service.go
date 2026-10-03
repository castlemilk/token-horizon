package service

// Daemon auto-start (Platform/DaemonAutoStart.swift port): user-scoped
// boot/login registration for the headless daemon. systemd --user + linger
// on Linux (XDG autostart fallback), LaunchAgent on macOS, a current-user
// Run entry on Windows. Never root/system-level — the daemon needs the user's
// credentials and config dirs. Generators are pure (unit-tested).

import (
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

const (
	UnitName       = "token-horizon-daemon.service"
	LaunchLabel    = "dev.token-horizon.daemon"
	autostartName  = "token-horizon-daemon.desktop"
	windowsRunKey  = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	windowsRunName = "TokenHorizonDaemon"
)

// Status: user-scoped service state for GET /service.
type Status struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Enabled   bool   `json:"enabled"`
	Running   bool   `json:"running"`
	Detail    string `json:"detail"`
}

// ---- Pure generators ----

func SystemdUnit(execPath string) string {
	return `[Unit]
Description=Token Horizon headless usage daemon (loopback API on :8765)
After=network-online.target

[Service]
ExecStart=` + systemdExec(execPath) + `
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target

`
}

func AutostartDesktop(execPath string) string {
	return `[Desktop Entry]
Type=Application
Name=Token Horizon daemon
Comment=Token Horizon headless usage daemon (loopback API on :8765)
Exec=` + desktopExec(execPath) + `
Terminal=false
X-GNOME-Autostart-enabled=true

`
}

func LaunchAgentPlist(label, execPath, logPath string) string {
	label, execPath, logPath = html.EscapeString(label), html.EscapeString(execPath), html.EscapeString(logPath)
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>` + label + `</string>
    <key>ProgramArguments</key>
    <array><string>` + execPath + `</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>` + logPath + `</string>
    <key>StandardErrorPath</key><string>` + logPath + `</string>
</dict>
</plist>

`
}

func systemdExec(execPath string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, "\n", `\n`, "\r", `\r`).Replace(execPath) + `"`
}

func desktopExec(execPath string) string {
	return `"` + strings.NewReplacer(`\`, `\\\\`, `"`, `\\"`, "`", "\\\\`", `$`, `\\$`, `%`, `%%`).Replace(execPath) + `"`
}

// ---- paths ----

func configHome() string {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return xdg
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config")
}

func unitPath() string { return filepath.Join(configHome(), "systemd/user", UnitName) }

func autostartPath() string { return filepath.Join(configHome(), "autostart", autostartName) }

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library/LaunchAgents", LaunchLabel+".plist")
}

func executablePath() string {
	p, err := os.Executable()
	if err != nil {
		return "token-horizon-daemon"
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		return resolved
	}
	return p
}

// ---- operations ----

func run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	platform.HideConsole(cmd)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func Current() Status {
	switch runtime.GOOS {
	case "linux":
		return linuxStatus()
	case "darwin":
		return darwinStatus()
	case "windows":
		return windowsStatus()
	default:
		return Status{Supported: false, Detail: "auto-start not supported on " + runtime.GOOS}
	}
}

func Install() Status {
	switch runtime.GOOS {
	case "linux":
		return linuxInstall()
	case "darwin":
		return darwinInstall()
	case "windows":
		return windowsInstall()
	default:
		return Status{Supported: false, Detail: "auto-start not supported on " + runtime.GOOS}
	}
}

func Uninstall() Status {
	switch runtime.GOOS {
	case "linux":
		return linuxUninstall()
	case "darwin":
		return darwinUninstall()
	case "windows":
		return windowsUninstall()
	default:
		return Status{Supported: false, Detail: "auto-start not supported on " + runtime.GOOS}
	}
}

// ---- Windows: current-user login registration (no administrator rights) ----

func WindowsRunCommand(execPath string) string { return `"` + execPath + `"` }

func windowsStatus() Status {
	_, err := run("reg.exe", "query", windowsRunKey, "/v", windowsRunName)
	installed := err == nil
	return Status{Supported: true, Installed: installed, Enabled: installed,
		Detail: "current-user login startup"}
}

func windowsInstall() Status {
	out, err := run("reg.exe", "add", windowsRunKey, "/v", windowsRunName,
		"/t", "REG_SZ", "/d", WindowsRunCommand(executablePath()), "/f")
	if err != nil {
		return Status{Supported: true, Detail: "login startup: " + out}
	}
	return windowsStatus()
}

func windowsUninstall() Status {
	if !windowsStatus().Installed {
		return Status{Supported: true, Detail: "login startup already removed"}
	}
	out, err := run("reg.exe", "delete", windowsRunKey, "/v", windowsRunName, "/f")
	if err != nil {
		st := windowsStatus()
		st.Detail = "remove login startup: " + out
		return st
	}
	return Status{Supported: true, Detail: "login startup removed"}
}

// ---- Linux: systemd --user (+ linger); XDG autostart fallback ----

func hasSystemdUser() bool {
	_, err := run("systemctl", "--user", "list-units")
	return err == nil
}

func linuxStatus() Status {
	st := Status{Supported: true}
	if !hasSystemdUser() {
		_, err := os.Stat(autostartPath())
		st.Installed = err == nil
		st.Enabled = st.Installed
		st.Detail = "no systemd --user; XDG autostart fallback"
		return st
	}
	_, err := os.Stat(unitPath())
	st.Installed = err == nil
	st.Enabled = run0("systemctl", "--user", "is-enabled", UnitName)
	st.Running = run0("systemctl", "--user", "is-active", "--quiet", UnitName)
	if linger, _ := run("loginctl", "show-user", os.Getenv("USER"), "--property=Linger"); strings.Contains(linger, "yes") {
		st.Detail = "linger enabled (starts at boot before login)"
	}
	return st
}

func run0(name string, args ...string) bool {
	_, err := run(name, args...)
	return err == nil
}

func linuxInstall() Status {
	if !hasSystemdUser() {
		if err := os.MkdirAll(filepath.Dir(autostartPath()), 0o755); err != nil {
			return Status{Supported: true, Detail: "autostart mkdir: " + err.Error()}
		}
		if err := os.WriteFile(autostartPath(), []byte(AutostartDesktop(executablePath())), 0o644); err != nil {
			return Status{Supported: true, Detail: "autostart write: " + err.Error()}
		}
		return Status{Supported: true, Installed: true, Enabled: true, Detail: "no systemd --user; XDG autostart installed"}
	}
	if err := os.MkdirAll(filepath.Dir(unitPath()), 0o755); err != nil {
		return Status{Supported: true, Detail: "unit mkdir: " + err.Error()}
	}
	if err := os.WriteFile(unitPath(), []byte(SystemdUnit(executablePath())), 0o644); err != nil {
		return Status{Supported: true, Detail: "unit write: " + err.Error()}
	}
	run("systemctl", "--user", "daemon-reload")
	out, err := run("systemctl", "--user", "enable", "--now", UnitName)
	if err != nil {
		return Status{Supported: true, Installed: true, Detail: "enable: " + out}
	}
	// Linger: start at boot before first login. Best-effort.
	run("loginctl", "enable-linger", os.Getenv("USER"))
	return linuxStatus()
}

func linuxUninstall() Status {
	if !hasSystemdUser() {
		os.Remove(autostartPath())
		return Status{Supported: true, Detail: "autostart removed"}
	}
	run("systemctl", "--user", "disable", "--now", UnitName)
	os.Remove(unitPath())
	run("systemctl", "--user", "daemon-reload")
	return Status{Supported: true, Detail: "disabled + unit removed"}
}

// ---- macOS: LaunchAgent ----

func darwinStatus() Status {
	st := Status{Supported: true}
	_, err := os.Stat(plistPath())
	st.Installed = err == nil
	st.Enabled = st.Installed
	out, _ := run("launchctl", "list")
	st.Running = strings.Contains(out, LaunchLabel)
	return st
}

func darwinInstall() Status {
	home, _ := os.UserHomeDir()
	logPath := filepath.Join(home, ".config/token-horizon/daemon.log")
	if err := os.MkdirAll(filepath.Dir(plistPath()), 0o755); err != nil {
		return Status{Supported: true, Detail: "LaunchAgents mkdir: " + err.Error()}
	}
	if err := os.WriteFile(plistPath(), []byte(LaunchAgentPlist(LaunchLabel, executablePath(), logPath)), 0o644); err != nil {
		return Status{Supported: true, Detail: "plist write: " + err.Error()}
	}
	out, err := run("launchctl", "load", plistPath())
	if err != nil {
		return Status{Supported: true, Installed: true, Enabled: true, Detail: "load: " + out}
	}
	return darwinStatus()
}

func darwinUninstall() Status {
	run("launchctl", "unload", plistPath())
	os.Remove(plistPath())
	return Status{Supported: true, Detail: "unloaded + plist removed"}
}
