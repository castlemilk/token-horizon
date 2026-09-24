package system

// Docker observer — System/DockerObserver.swift port. `docker ps` for
// metadata (image/status/ports) + `docker stats --no-stream` for live
// metrics, both as line-delimited JSON. 2.5s result cache; returns the last
// good sample when docker is absent or errors mid-poll.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type DockerContainerSample struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Image       string  `json:"image"`
	CPU         float64 `json:"cpu"`
	MemMB       float64 `json:"memMB"`
	MemLimitMB  float64 `json:"memLimitMB"`
	MemPercent  float64 `json:"memPercent"`
	NetInMB     float64 `json:"netInMB"`
	NetOutMB    float64 `json:"netOutMB"`
	DiskReadMB  float64 `json:"diskReadMB"`
	DiskWriteMB float64 `json:"diskWriteMB"`
	PIDs        int     `json:"pids"`
	Status      string  `json:"status"`
	Ports       string  `json:"ports"`
}

var dockerCache struct {
	mu      sync.Mutex
	samples []DockerContainerSample
	at      time.Time
}

const dockerCacheTTL = 2500 * time.Millisecond

func FindDockerExecutable() string {
	home, _ := os.UserHomeDir()
	candidates := []string{
		"/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker",
		"/Applications/Docker.app/Contents/Resources/bin/docker",
		filepath.Join(home, ".docker/bin/docker"),
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	for _, dir := range strings.Split(os.Getenv("PATH"), ":") {
		p := filepath.Join(strings.TrimSpace(dir), "docker")
		if fi, err := os.Stat(p); err == nil && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

func dockerRun(bin string, args ...string) []byte {
	out, err := exec.Command(bin, args...).Output()
	if err != nil {
		return nil
	}
	return out
}

func parsePercent(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, "%")), 64)
	return v
}

// parseBytesMB: "1.5GiB" / "42kB" / "512B" → MB (binary units).
func parseBytesMB(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "0B" || s == "0" {
		return 0
	}
	var num, unit string
	for _, c := range s {
		if (c >= '0' && c <= '9') || c == '.' {
			num += string(c)
		} else {
			unit += string(c)
		}
	}
	v, _ := strconv.ParseFloat(num, 64)
	switch strings.ToLower(strings.TrimSpace(unit)) {
	case "b":
		return v / (1024 * 1024)
	case "k", "kb", "kib":
		return v / 1024
	case "m", "mb", "mib":
		return v
	case "g", "gb", "gib":
		return v * 1024
	case "t", "tb", "tib":
		return v * 1024 * 1024
	case "p", "pb", "pib":
		return v * 1024 * 1024 * 1024
	}
	return v
}

func parseSlashPairMB(s string) (float64, float64) {
	parts := strings.Split(s, "/")
	if len(parts) != 2 {
		return 0, 0
	}
	return parseBytesMB(parts[0]), parseBytesMB(parts[1])
}

type dockerMeta struct {
	image, status, ports string
}

func parseDockerPs(data []byte) map[string]dockerMeta {
	out := map[string]dockerMeta{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var obj map[string]any
		if json.Unmarshal([]byte(line), &obj) != nil {
			continue
		}
		id, _ := obj["ID"].(string)
		if id == "" {
			continue
		}
		m := dockerMeta{
			image:  strField(obj, "Image"),
			status: strField(obj, "Status"),
			ports:  strField(obj, "Ports"),
		}
		out[id] = m
		if len(id) > 12 {
			out[id[:12]] = m
		}
	}
	return out
}

func strField(o map[string]any, k string) string {
	s, _ := o[k].(string)
	return s
}

func parseDockerStats(data []byte, meta map[string]dockerMeta) []DockerContainerSample {
	var out []DockerContainerSample
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var obj map[string]any
		if json.Unmarshal([]byte(line), &obj) != nil {
			continue
		}
		rawID := strField(obj, "ID")
		if rawID == "" {
			rawID = strField(obj, "Container")
		}
		id := rawID
		if len(id) > 12 {
			id = id[:12]
		}
		memUsed, memLimit := parseSlashPairMB(strField(obj, "MemUsage"))
		netIn, netOut := parseSlashPairMB(strField(obj, "NetIO"))
		diskR, diskW := parseSlashPairMB(strField(obj, "BlockIO"))
		pids, _ := strconv.Atoi(strings.TrimSpace(strField(obj, "PIDs")))
		m := meta[id]
		if m.image == "" {
			m = meta[rawID]
		}
		out = append(out, DockerContainerSample{
			ID: id, Name: strField(obj, "Name"), Image: m.image,
			CPU:        parsePercent(strField(obj, "CPUPerc")),
			MemMB:      memUsed,
			MemLimitMB: memLimit,
			MemPercent: parsePercent(strField(obj, "MemPerc")),
			NetInMB:    netIn, NetOutMB: netOut,
			DiskReadMB: diskR, DiskWriteMB: diskW,
			PIDs: pids, Status: m.status, Ports: m.ports,
		})
	}
	return out
}

// DockerContainers samples running containers (2.5s cache; empty when the
// docker CLI is absent — honest, matches Swift's nil→[] collapse).
func DockerContainers() []DockerContainerSample {
	dockerCache.mu.Lock()
	if time.Since(dockerCache.at) < dockerCacheTTL && dockerCache.samples != nil {
		res := dockerCache.samples
		dockerCache.mu.Unlock()
		return res
	}
	dockerCache.mu.Unlock()

	bin := FindDockerExecutable()
	if bin == "" {
		return nil
	}
	meta := parseDockerPs(dockerRun(bin, "ps", "--format", "{{json .}}"))
	stats := dockerRun(bin, "stats", "--no-stream", "--format", "{{json .}}")
	if stats == nil {
		dockerCache.mu.Lock()
		defer dockerCache.mu.Unlock()
		return dockerCache.samples
	}
	samples := parseDockerStats(stats, meta)
	dockerCache.mu.Lock()
	dockerCache.samples = samples
	dockerCache.at = time.Now()
	dockerCache.mu.Unlock()
	return samples
}

// Docker role classification — which process hosts the containers.
type DockerRole int

const (
	RoleNone DockerRole = iota
	RolePrimaryVM
	RoleBackendDaemon
	RoleDesktopHelper
	RoleCLI
)

func DockerRoleOf(name, command string) DockerRole {
	n, c := strings.ToLower(name), strings.ToLower(command)
	if n == "com.apple.virtualization.virtualmachine" || strings.Contains(c, "virtualization.virtualmachine") ||
		n == "vmmem" || n == "vmmemwsl" || strings.Contains(c, "vmmem") ||
		n == "com.docker.virtualization" || strings.Contains(c, "com.docker.virtualization") ||
		n == "dockerd" || n == "containerd" || n == "orbctl" || n == "colima" {
		return RolePrimaryVM
	}
	if strings.Contains(n, "com.docker.backend") || strings.Contains(c, "com.docker.backend") ||
		strings.Contains(n, "com.docker.service") {
		return RoleBackendDaemon
	}
	if strings.Contains(n, "docker desktop") || strings.Contains(n, "docker-agent") ||
		strings.Contains(n, "com.docker.proxy") || strings.Contains(c, "docker desktop") {
		return RoleDesktopHelper
	}
	if n == "docker" || n == "docker-compose" || strings.Contains(n, "docker-shim") ||
		strings.Contains(c, "bin/docker") {
		return RoleCLI
	}
	if strings.Contains(n, "docker") || strings.Contains(c, "docker") {
		return RoleDesktopHelper
	}
	return RoleNone
}

// PrimaryDockerPid: the single container-execution host (highest-RSS VM,
// else first primary engine) — same anchor the Swift route reports.
func PrimaryDockerPid(procs []ProcSample) (int32, bool) {
	var best *ProcSample
	for i := range procs {
		p := &procs[i]
		if DockerRoleOf(p.Name, p.Command) != RolePrimaryVM {
			continue
		}
		if best == nil || p.MemMB > best.MemMB {
			best = p
		}
	}
	if best == nil {
		return 0, false
	}
	return best.PID, true
}
