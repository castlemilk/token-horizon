//go:build windows

package engine

import (
	"os/exec"
	"strconv"
	"strings"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

// hostInfo: CPU name via PowerShell CIM (same approach system_windows.go
// uses); no macOS version on Windows.
func hostInfo() (chip string, major, minor int) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-CimInstance Win32_Processor | Select-Object -First 1).Name")
	platform.HideConsole(cmd)
	out, err := cmd.Output()
	if err == nil {
		chip = strings.TrimSpace(string(out))
	}
	if chip == "" {
		chip = "unknown"
	}
	return chip, 0, 0
}

// totalMemoryGB: TotalPhysicalMemory via CIM.
func totalMemoryGB() float64 {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")
	platform.HideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	b, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return b / 1073741824
}
