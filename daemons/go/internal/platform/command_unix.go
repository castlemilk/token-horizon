//go:build !windows

package platform

import "os/exec"

func HideConsole(cmd *exec.Cmd) {}
