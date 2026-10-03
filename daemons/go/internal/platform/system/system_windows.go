//go:build windows

package system

// Windows probes use CIM class properties rather than localized performance
// counter names. No cgo, administrator rights, or external tools are needed.

import (
	"context"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

var (
	lock         sync.Mutex
	lastSnapshot Snapshot
	snapshotAt   time.Time
	processLock  sync.Mutex
	processAt    time.Time
	processCPU   = map[int32]windowsCPUSample{}
)

type windowsCPUSample struct {
	start   int64
	seconds float64
}

func psJSON(script string) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; `+script)
	platform.HideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return out
}

func TakeSnapshot() Snapshot {
	lock.Lock()
	defer lock.Unlock()
	if !snapshotAt.IsZero() && time.Since(snapshotAt) < 4*time.Second {
		return lastSnapshot
	}
	used, total := memoryGB()
	diskMBps, netMBps := ioRates()
	lastSnapshot = Snapshot{
		CPUPercent: cpuPercent(),
		RAMUsedGB:  used, RAMTotalGB: total,
		DiskMBps: diskMBps, NetMBps: netMBps,
	}
	snapshotAt = time.Now()
	return lastSnapshot
}

func cpuPercent() float64 {
	out := psJSON(`(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime`)
	v, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	return v
}

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

func ioRates() (diskMBps, netMBps float64) {
	out := psJSON(`$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"; $n = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface; "$($d.DiskBytesPersec) $(($n | Measure-Object BytesTotalPersec -Sum).Sum)"`)
	f := strings.Fields(string(out))
	if len(f) == 2 {
		d, _ := strconv.ParseFloat(f[0], 64)
		n, _ := strconv.ParseFloat(f[1], 64)
		diskMBps = d / 1048576
		netMBps = n / 1048576
	}
	return
}

// AllProcesses emits scalar properties explicitly: Get-Process.Threads is
// a collection and its DateTime JSON varies by PowerShell version. CIM also
// supplies parent PIDs and full arguments for runtime/process-tree discovery.
func AllProcesses() []ProcSample {
	processLock.Lock()
	defer processLock.Unlock()
	out := psJSON(`Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; command=$_.CommandLine; threads=[int]$_.ThreadCount; workingSetBytes=[double]$_.WorkingSetSize; cpuSeconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000; startTime=$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() } else { 0 }) } } | ConvertTo-Json -Compress`)
	rows, err := decodeWindowsProcesses(out)
	if err != nil {
		return nil
	}
	now := time.Now()
	interval := now.Sub(processAt).Seconds()
	ncpu := float64(runtime.NumCPU())
	next := make(map[int32]windowsCPUSample, len(rows))
	samples := make([]ProcSample, 0, len(rows))
	for _, p := range rows {
		cmd := p.Command
		if cmd == "" {
			cmd = p.Name
		}
		var cpuPct float64
		if prev, ok := processCPU[p.PID]; ok && prev.start == p.StartTime &&
			interval > 0 && p.CPUSeconds >= prev.seconds {
			cpuPct = (p.CPUSeconds - prev.seconds) / interval / ncpu * 100
		}
		next[p.PID] = windowsCPUSample{start: p.StartTime, seconds: p.CPUSeconds}
		samples = append(samples, ProcSample{
			PID: p.PID, PPID: p.PPID, Name: p.Name, Command: cmd,
			Threads: p.Threads, CPU: cpuPct, MemMB: p.WorkingSetBytes / 1048576,
			StartTime: p.StartTime,
		})
	}
	processCPU, processAt = next, now
	return samples
}
