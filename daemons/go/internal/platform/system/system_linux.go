//go:build linux

package system

// Linux backend: /proc + procps ps. CPU/RAM/load from /proc/stat,
// /proc/meminfo, /proc/loadavg; disk throughput from /proc/diskstats
// sector deltas; network throughput from /proc/net/dev non-loopback
// byte deltas.

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	lock     sync.Mutex
	prevCPU  *struct{ busy, total uint64 }
	prevDisk *struct {
		sectors uint64
		at      time.Time
	}
	prevNet *struct {
		bytes uint64
		at    time.Time
	}
)

func TakeSnapshot() Snapshot {
	var snap Snapshot
	snap.CPUPercent = cpuPercent()
	snap.RAMUsedGB, snap.RAMTotalGB = memoryGB()
	snap.LoadAvg1 = loadAvg()
	disk, net := ioRates(time.Now())
	snap.DiskMBps = disk
	snap.NetMBps = net
	return snap
}

func ioRates(now time.Time) (diskMBps, netMBps float64) {
	lock.Lock()
	defer lock.Unlock()
	if sectors := diskSectorTotal(); sectors != nil {
		if prevDisk != nil {
			dt := now.Sub(prevDisk.at).Seconds()
			if dt > 0 && *sectors >= prevDisk.sectors {
				diskMBps = float64(*sectors-prevDisk.sectors) * 512.0 / 1_048_576.0 / dt
			}
		}
		prevDisk = &struct {
			sectors uint64
			at      time.Time
		}{*sectors, now}
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
	return diskMBps, netMBps
}

func cpuPercent() float64 {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line[3:])
		if len(fields) < 5 {
			return 0
		}
		var total, idle uint64
		for i, f := range fields {
			v, _ := strconv.ParseUint(f, 10, 64)
			total += v
			if i == 3 || i == 4 { // idle + iowait
				idle += v
			}
		}
		busy := total - idle
		lock.Lock()
		defer lock.Unlock()
		defer func() { prevCPU = &struct{ busy, total uint64 }{busy, total} }()
		if prevCPU == nil || total <= prevCPU.total || busy < prevCPU.busy {
			return 0
		}
		return float64(busy-prevCPU.busy) / float64(total-prevCPU.total) * 100
	}
	return 0
}

func memoryGB() (used, total float64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	var totalKB, availKB float64
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(fields[1], 64)
		switch fields[0] {
		case "MemTotal:":
			totalKB = v
		case "MemAvailable:":
			availKB = v
		}
	}
	total = totalKB / 1_048_576
	used = total - availKB/1_048_576
	if used < 0 {
		used = 0
	}
	return used, total
}

func loadAvg() float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	v, _ := strconv.ParseFloat(strings.Fields(string(data))[0], 64)
	return v
}

func diskSectorTotal() *uint64 {
	data, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return nil
	}
	var sectors uint64
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		name := f[2]
		// Count whole disks only — skip partitions and virtual devices.
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "dm-") {
			continue
		}
		if isPartition(name) {
			continue
		}
		rd, _ := strconv.ParseUint(f[5], 10, 64)
		wr, _ := strconv.ParseUint(f[9], 10, 64)
		sectors += rd + wr
	}
	return &sectors
}

// isPartition: sda1/vda2/xvda3/hda4 or nvme0n1p2/mmcblk0p1.
func isPartition(name string) bool {
	for _, prefix := range []string{"sd", "vd", "hd", "xvd"} {
		if strings.HasPrefix(name, prefix) {
			rest := name[len(prefix):]
			i := 0
			for i < len(rest) && rest[i] >= 'a' && rest[i] <= 'z' {
				i++
			}
			if i > 0 && i < len(rest) {
				return true // letters followed by digits
			}
		}
	}
	if strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "mmcblk") {
		if strings.Contains(name, "p") {
			idx := strings.LastIndex(name, "p")
			if idx > 0 && idx < len(name)-1 {
				_, err := strconv.Atoi(name[idx+1:])
				return err == nil
			}
		}
	}
	return false
}

func netByteTotal() *uint64 {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nil
	}
	var bytes uint64
	for _, line := range strings.Split(string(data), "\n") {
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		iface := strings.TrimSpace(line[:colon])
		if iface == "lo" {
			continue
		}
		f := strings.Fields(line[colon+1:])
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		bytes += rx + tx
	}
	return &bytes
}

// AllProcesses: the full ps table (runtime signature detection needs more
// than the top-8 decoration lists).
func AllProcesses() []ProcSample { return psSamples() }

func psSamples() []ProcSample {
	ps := "/bin/ps"
	if _, err := os.Stat(ps); err != nil {
		ps = "/usr/bin/ps"
	}
	out, err := exec.Command(ps, "-axo", "pid=,ppid=,nlwp=,%cpu=,rss=,etime=,user=,comm=").Output()
	if err != nil {
		return nil
	}
	now := time.Now()
	var samples []ProcSample
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 8 {
			continue
		}
		pid64, err := strconv.ParseInt(f[0], 10, 32)
		if err != nil {
			continue
		}
		ppid64, _ := strconv.ParseInt(f[1], 10, 32)
		threads, _ := strconv.Atoi(f[2])
		cpu, _ := strconv.ParseFloat(f[3], 64)
		rssKB, _ := strconv.ParseFloat(f[4], 64)
		elapsed := parseElapsed(f[5])
		command := strings.Join(f[7:], " ")
		name := command
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		samples = append(samples, ProcSample{
			PID: int32(pid64), PPID: int32(ppid64), Name: name, Command: command,
			User: f[6], Threads: threads, CPU: cpu, MemMB: rssKB / 1024,
			StartTime: now.Add(-time.Duration(elapsed * float64(time.Second))).Unix(),
		})
	}
	return samples
}

// parseElapsed: ps etime [[dd-]hh:]mm:ss → seconds.
