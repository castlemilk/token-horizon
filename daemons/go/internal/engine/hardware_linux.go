//go:build linux

package engine

import (
	"os"
	"strconv"
	"strings"
)

// hostInfo: CPU model name from /proc/cpuinfo; no macOS version on Linux.
func hostInfo() (chip string, major, minor int) {
	data, _ := os.ReadFile("/proc/cpuinfo")
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "model name") {
			if i := strings.IndexByte(line, ':'); i >= 0 {
				chip = strings.TrimSpace(line[i+1:])
			}
			break
		}
	}
	if chip == "" {
		chip = "unknown"
	}
	return chip, 0, 0
}

// totalMemoryGB: /proc/meminfo MemTotal — same source system_linux.go uses.
func totalMemoryGB() float64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			f := strings.Fields(line)
			if len(f) >= 2 {
				kb, _ := strconv.ParseFloat(f[1], 64)
				return kb / 1048576
			}
		}
	}
	return 0
}
