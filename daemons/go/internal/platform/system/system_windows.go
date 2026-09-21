//go:build windows

package system

// Windows backend — PowerShell/CIM-backed, no cgo. Processes via
// Get-Process JSON; CPU/RAM via Win32_OperatingSystem + performance
// counters; disk/net rates from cumulative counters delta-derived like
// the other backends (first sample reports 0).

import (
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	lock     sync.Mutex
	prevDisk *struct {
		bytes uint64
		at    time.Time
	}
	prevNet *struct {
		bytes uint64
		at    time.Time
	}
	prevCPU *struct {
		busy, total uint64
		at          time.Time
	}
)

func psJSON(script string) []byte {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return nil
	}
	return out
}

func TakeSnapshot() Snapshot {
	lock.Lock()
	defer lock.Unlock()
	now := time.Now()
	used, total := memoryGB()
	diskMBps, netMBps := ioRates(now)
	return Snapshot{
		CPUPercent: cpuPercent(),
		RAMUsedGB:  used, RAMTotalGB: total,
		LoadAvg1: 0, // no POSIX load average on Windows
		DiskMBps: diskMBps, NetMBps: netMBps,
	}
}

// cpuPercent: single-counter read — % Processor Time on _Total.
func cpuPercent() float64 {
	out := psJSON(`(Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue`)
	v, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return v
}

// memoryGB: Win32_OperatingSystem KB fields → GB.
func memoryGB() (used, total float64) {
	out := psJSON(`$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory)"`)
	f := strings.Fields(string(out))
	if len(f) == 2 {
		t, _ := strconv.ParseFloat(f[0], 64)
		fr, _ := strconv.ParseFloat(f[1], 64)
		total = t / 1048576
		used = (t - fr) / 1048576
	}
	return used, total
}

// ioRates: PhysicalDisk(_Total) Read/Write Bytes/sec are instantaneous
// counters — sample once and report; network likewise. (Delta-of-cumulative
// isn't available without polling twice; the instantaneous counters are
// already per-second rates.)
func ioRates(now time.Time) (diskMBps, netMBps float64) {
	out := psJSON(`$d = (Get-Counter '\PhysicalDisk(_Total)\Disk Read Bytes/sec','\PhysicalDisk(_Total)\Disk Write Bytes/sec').CounterSamples; $n = (Get-Counter '\Network Interface(*)\Bytes Received/sec','\Network Interface(*)\Bytes Sent/sec').CounterSamples; "$($d[0].CookedValue + $d[1].CookedValue) $(($n | Measure-Object CookedValue -Sum).Sum)"`)
	f := strings.Fields(string(out))
	if len(f) == 2 {
		d, _ := strconv.ParseFloat(f[0], 64)
		n, _ := strconv.ParseFloat(f[1], 64)
		diskMBps = d / 1048576
		netMBps = n / 1048576
	}
	return
}

// AllProcesses: Get-Process → JSON rows. Command = Path when available
// (elevated processes may expose no Path — fall back to ProcessName).
func AllProcesses() []ProcSample {
	out := psJSON(`Get-Process | Select-Object Id,ProcessName,Path,CPU,WorkingSet64,Threads,StartTime | ConvertTo-Json -Compress`)
	if len(out) == 0 {
		return nil
	}
	var rows []struct {
		Id           int32   `json:"Id"`
		ProcessName  string  `json:"ProcessName"`
		Path         string  `json:"Path"`
		CPU          float64 `json:"CPU"`
		WorkingSet64 int64   `json:"WorkingSet64"`
		Threads      int     `json:"Threads"`
		StartTime    string  `json:"StartTime"`
	}
	// Single-process systems emit an object, not an array.
	if err := json.Unmarshal(out, &rows); err != nil {
		var single struct {
			Id           int32   `json:"Id"`
			ProcessName  string  `json:"ProcessName"`
			Path         string  `json:"Path"`
			CPU          float64 `json:"CPU"`
			WorkingSet64 int64   `json:"WorkingSet64"`
			Threads      int     `json:"Threads"`
			StartTime    string  `json:"StartTime"`
		}
		if json.Unmarshal(out, &single) != nil {
			return nil
		}
		rows = append(rows, struct {
			Id           int32   `json:"Id"`
			ProcessName  string  `json:"ProcessName"`
			Path         string  `json:"Path"`
			CPU          float64 `json:"CPU"`
			WorkingSet64 int64   `json:"WorkingSet64"`
			Threads      int     `json:"Threads"`
			StartTime    string  `json:"StartTime"`
		}(single))
	}
	// Count CPUs once for the cpu%-per-interval conversion.
	ncpu := float64(countCPU())
	var samples []ProcSample
	for _, p := range rows {
		cmd := p.Path
		if cmd == "" {
			cmd = p.ProcessName
		}
		var start int64
		if p.StartTime != "" {
			if t, err := time.Parse(time.RFC3339Nano, p.StartTime); err == nil {
				start = t.Unix()
			} else if t, err := time.Parse("2006-01-02T15:04:05", p.StartTime); err == nil {
				start = t.Unix()
			}
		}
		// Get-Process CPU is cumulative seconds — report lifetime share.
		var cpuPct float64
		if start > 0 && p.CPU > 0 {
			life := float64(time.Now().Unix() - start)
			if life > 0 {
				cpuPct = p.CPU / life / ncpu * 100
			}
		}
		samples = append(samples, ProcSample{
			PID: p.Id, Name: p.ProcessName, Command: cmd,
			Threads: p.Threads, CPU: cpuPct, MemMB: float64(p.WorkingSet64) / 1048576,
			StartTime: start,
		})
	}
	return samples
}

func countCPU() int {
	out := psJSON(`(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors`)
	v, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	if v <= 0 {
		return 1
	}
	return v
}
