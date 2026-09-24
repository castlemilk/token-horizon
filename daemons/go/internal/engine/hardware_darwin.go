//go:build darwin

package engine

import (
	"os/exec"
	"strconv"
	"strings"
)

// hostInfo: machdep.cpu.brand_string + sw_vers productVersion — the same
// sources the Swift SystemStats/ProcessInfo report.
func hostInfo() (chip string, major, minor int) {
	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
		chip = strings.TrimSpace(string(out))
	}
	if chip == "" {
		chip = "Apple Silicon"
	}
	if out, err := exec.Command("/usr/bin/sw_vers", "-productVersion").Output(); err == nil {
		parts := strings.Split(strings.TrimSpace(string(out)), ".")
		if len(parts) > 0 {
			major, _ = strconv.Atoi(parts[0])
		}
		if len(parts) > 1 {
			minor, _ = strconv.Atoi(parts[1])
		}
	}
	return chip, major, minor
}

// totalMemoryGB: sysctl hw.memsize.
func totalMemoryGB() float64 {
	out, err := exec.Command("/usr/sbin/sysctl", "-n", "hw.memsize").Output()
	if err != nil {
		return 0
	}
	b, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return b / 1073741824
}
