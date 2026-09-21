package system

// System stats — shared DTOs and helpers. Per-OS backends live in
// system_linux.go (/proc + ps) and system_darwin.go (top/vm_stat/sysctl/
// netstat/iostat + ps). Rates are delta-derived: the first sample after
// baseline reports 0.

import (
	"os"
	"sort"
	"strconv"
	"strings"
)

// ProcSample mirrors the Swift DTO (per-process disk/net rates are not
// populated on Linux — 0).
type ProcSample struct {
	PID       int32   `json:"pid"`
	PPID      int32   `json:"ppid"`
	Name      string  `json:"name"`
	Command   string  `json:"command"`
	User      string  `json:"user"`
	Threads   int     `json:"threads"`
	CPU       float64 `json:"cpu"`
	MemMB     float64 `json:"memMB"`
	DiskRead  float64 `json:"diskReadMBps"`
	DiskWrite float64 `json:"diskWriteMBps"`
	NetIn     float64 `json:"netInKBps"`
	NetOut    float64 `json:"netOutKBps"`
	StartTime int64   `json:"startTime"`
}

type Snapshot struct {
	CPUPercent float64 `json:"cpuPercent"`
	RAMUsedGB  float64 `json:"ramUsedGB"`
	RAMTotalGB float64 `json:"ramTotalGB"`
	LoadAvg1   float64 `json:"loadAvg1"`
	DiskMBps   float64 `json:"diskMBps"`
	NetMBps    float64 `json:"netMBps"`
}

// ProcessSamples: top-8 by CPU and by RSS (ProcessSamples contract).
func ProcessSamples() (byCPU, byMem []ProcSample) {
	all := AllProcesses()
	byCPU = append([]ProcSample{}, all...)
	byMem = append([]ProcSample{}, all...)
	sort.Slice(byCPU, func(i, j int) bool { return byCPU[i].CPU > byCPU[j].CPU })
	sort.Slice(byMem, func(i, j int) bool { return byMem[i].MemMB > byMem[j].MemMB })
	if len(byCPU) > 8 {
		byCPU = byCPU[:8]
	}
	if len(byMem) > 8 {
		byMem = byMem[:8]
	}
	return
}

// parseElapsed: ps etime [[dd-]hh:]mm:ss → seconds.
func parseElapsed(s string) float64 {
	days := 0.0
	rest := s
	if dash := strings.Index(rest, "-"); dash >= 0 {
		days, _ = strconv.ParseFloat(rest[:dash], 64)
		rest = rest[dash+1:]
	}
	seconds := days * 86_400
	for _, p := range strings.Split(rest, ":") {
		v, _ := strconv.ParseFloat(p, 64)
		seconds = seconds*60 + v
	}
	return seconds
}

// Kill terminates a process (SIGTERM default).
func Kill(pid int32, sig os.Signal) error {
	proc, err := os.FindProcess(int(pid))
	if err != nil {
		return err
	}
	return proc.Signal(sig)
}
