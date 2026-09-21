//go:build darwin

package system

// macOS backend — no cgo, all shell-backed (mirrors the tools the Swift
// SystemStats uses): `top -l 2` for CPU%, `vm_stat` + sysctl hw.memsize for
// RAM, `sysctl vm.loadavg`, `iostat -dI` cumulative MB for disk rates,
// `netstat -ibn` cumulative bytes for net rates, procps-style ps for rows.
// Rates are delta-derived like the Linux backend: first sample reports 0.

import (
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	lock     sync.Mutex
	prevDisk *struct {
		mb uint64
		at time.Time
	}
	prevNet *struct {
		bytes uint64
		at    time.Time
	}
)

func TakeSnapshot() Snapshot {
	lock.Lock()
	defer lock.Unlock()
	now := time.Now()
	used, total := memoryGB()
	diskMBps, netMBps := ioRates(now)
	return Snapshot{
		CPUPercent: cpuPercent(),
		RAMUsedGB:  used, RAMTotalGB: total,
		LoadAvg1: loadAvg(),
		DiskMBps: diskMBps, NetMBps: netMBps,
	}
}

func run(name string, args ...string) []byte {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return nil
	}
	return out
}

// cpuPercent: `top -l 2 -n 0 -s 1` — the second sample is the measured one.
// ~1s wall time; fine for the poll cadence (stats route is 2s-polled).
func cpuPercent() float64 {
	out := run("/usr/bin/top", "-l", "2", "-n", "0", "-s", "1")
	var idle float64
	found := false
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, "CPU usage") {
			continue
		}
		// "CPU usage: 5.26% user, 10.52% sys, 84.21% idle"
		for _, part := range strings.Split(line, ":")[1:] {
			for _, seg := range strings.Split(part, ",") {
				seg = strings.TrimSpace(seg)
				if strings.HasSuffix(seg, "idle") {
					v, _ := strconv.ParseFloat(strings.TrimSuffix(strings.Fields(seg)[0], "%"), 64)
					idle, found = v, true
				}
			}
		}
	}
	if !found {
		return 0
	}
	return 100 - idle
}

// memoryGB: used = (active + wired + compressor) * pageSize; total =
// hw.memsize. Same definition the Swift mach backend reports.
func memoryGB() (used, total float64) {
	if out := run("/usr/sbin/sysctl", "-n", "hw.memsize"); len(out) > 0 {
		v, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		total = v / 1073741824
	}
	out := run("/usr/bin/vm_stat")
	if len(out) == 0 {
		return 0, total
	}
	var pageSize float64 = 4096
	var active, wired, compressed float64
	for i, line := range strings.Split(string(out), "\n") {
		if i == 0 {
			// "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
			if idx := strings.Index(line, "page size of "); idx >= 0 {
				rest := line[idx+13:]
				if sp := strings.Index(rest, " "); sp > 0 {
					if v, err := strconv.ParseFloat(rest[:sp], 64); err == nil {
						pageSize = v
					}
				}
			}
			continue
		}
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		valStr := strings.TrimSuffix(strings.TrimSpace(line[colon+1:]), ".")
		v, _ := strconv.ParseFloat(strings.ReplaceAll(valStr, ",", ""), 64)
		switch key {
		case "Pages active":
			active = v
		case "Pages wired down":
			wired = v
		case "Pages occupied by compressor":
			compressed = v
		}
	}
	used = (active + wired + compressed) * pageSize / 1073741824
	return used, total
}

func loadAvg() float64 {
	out := run("/usr/sbin/sysctl", "-n", "vm.loadavg")
	// "{ 2.53 2.87 3.01 }"
	fields := strings.Fields(strings.Trim(string(out), "{ }\n"))
	if len(fields) > 0 {
		v, _ := strconv.ParseFloat(fields[0], 64)
		return v
	}
	return 0
}

// diskMBTotal: `iostat -dI` reports MB transferred since boot per disk
// (columns: KB/t, tps… no — with -I: KB/t xfrs MB). Sum the MB column.
func diskMBTotal() *uint64 {
	out := run("/usr/sbin/iostat", "-dI")
	if len(out) == 0 {
		return nil
	}
	var total uint64
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 4 || !strings.HasPrefix(f[0], "disk") {
			continue
		}
		mb, _ := strconv.ParseFloat(f[3], 64)
		total += uint64(mb)
	}
	return &total
}

// netByteTotal: `netstat -ibn` — sum Ibytes+Obytes on non-loopback ifaces.
func netByteTotal() *uint64 {
	out := run("/usr/sbin/netstat", "-ibn")
	if len(out) == 0 {
		return nil
	}
	var total uint64
	lines := strings.Split(string(out), "\n")
	for i, line := range lines {
		f := strings.Fields(line)
		if i == 0 || len(f) < 10 {
			continue
		}
		name := f[0]
		if strings.HasPrefix(name, "lo") {
			continue
		}
		// Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
		in, errIn := strconv.ParseUint(f[6], 10, 64)
		outB, errOut := strconv.ParseUint(f[9], 10, 64)
		if errIn == nil && errOut == nil {
			total += in + outB
		}
	}
	return &total
}

func ioRates(now time.Time) (diskMBps, netMBps float64) {
	if mb := diskMBTotal(); mb != nil {
		if prevDisk != nil {
			dt := now.Sub(prevDisk.at).Seconds()
			if dt > 0 && *mb >= prevDisk.mb {
				diskMBps = float64(*mb-prevDisk.mb) / dt
			}
		}
		prevDisk = &struct {
			mb uint64
			at time.Time
		}{*mb, now}
	}
	if bytes := netByteTotal(); bytes != nil {
		if prevNet != nil {
			dt := now.Sub(prevNet.at).Seconds()
			if dt > 0 && *bytes >= prevNet.bytes {
				netMBps = float64(*bytes-prevNet.bytes) / 1_048_576.0 / dt
			}
		}
		prevNet = &struct {
			bytes uint64
			at    time.Time
		}{*bytes, now}
	}
	return
}

// AllProcesses: macOS ps has no nlwp — threads column reports 0.
func AllProcesses() []ProcSample { return psSamples() }

func psSamples() []ProcSample {
	out, err := exec.Command("/bin/ps", "-axo", "pid=,ppid=,%cpu=,rss=,etime=,user=,comm=").Output()
	if err != nil {
		return nil
	}
	now := time.Now()
	var samples []ProcSample
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 7 {
			continue
		}
		pid64, err := strconv.ParseInt(f[0], 10, 32)
		if err != nil {
			continue
		}
		ppid64, _ := strconv.ParseInt(f[1], 10, 32)
		cpu, _ := strconv.ParseFloat(f[2], 64)
		rssKB, _ := strconv.ParseFloat(f[3], 64)
		elapsed := parseElapsed(f[4])
		command := strings.Join(f[6:], " ")
		name := command
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		samples = append(samples, ProcSample{
			PID: int32(pid64), PPID: int32(ppid64), Name: name, Command: command,
			User: f[5], CPU: cpu, MemMB: rssKB / 1024,
			StartTime: now.Add(-time.Duration(elapsed * float64(time.Second))).Unix(),
		})
	}
	return samples
}
