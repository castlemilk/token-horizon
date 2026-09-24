//go:build darwin

package keychain

// macOS Keychain read via the security(1) CLI (no cgo). Linux/Windows stub
// in keychain_stub.go returns "".

import (
	"os/exec"
	"strings"
)

func Read(service, account string) string {
	args := []string{"find-generic-password", "-s", service, "-w"}
	if account != "" {
		args = append(args, "-a", account)
	}
	out, err := exec.Command("/usr/bin/security", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
