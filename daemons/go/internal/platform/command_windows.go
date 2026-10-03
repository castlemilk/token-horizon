//go:build windows

package platform

import (
	"os/exec"
	"syscall"
)

// HideConsole keeps background probes and supervised tools from opening
// console windows when launched by the desktop app.
func HideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
