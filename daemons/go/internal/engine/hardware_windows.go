//go:build windows

package engine

import (
	"os/exec"
	"strconv"
	"strings"
)

// hostInfo: CPU name via PowerShell CIM (same approach system_windows.go
// uses); no macOS version on Windows.
func hostInfo() (chip string, major, minor int) {
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-CimInstance Win32_Processor | Select-Object -First 1).Name").Output()
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
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		"(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory").Output()
	if err != nil {
		return 0
	}
	b, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return b / 1073741824
}
