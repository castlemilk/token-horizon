package engine

// Engine supervisor — Go port of clients/macos
// Sources/TokenHorizon/Engine/EngineSupervisor.swift.
//
// Token Horizon supervises local inference engines as sidecars — the same
// attach-or-spawn discipline as the gateway: if a server already answers on
// the backend's loopback port we adopt it (read-only — we never kill a
// server we didn't start); otherwise serve() spawns the child and owns its
// log + shutdown.
//
//   - splash    (:8000) — incoai's specialized engine
//   - thengine  (:8001) — our Rust/candle engine (engine/)
//
// Both answer /status with an `instance` object, so the probe is uniform.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

// Backend is the static description of one supervised engine backend.
type Backend struct {
	ID               string // "splash" | "thengine"
	DisplayName      string
	Port             int
	BinaryEnvVar     string
	BinarySearchPath []string

	// Extra env for the spawned child.
	SpawnEnv map[string]string
}

// SpawnArgs builds the CLI args for a serve. `model` is the backend's model
// spec (HF repo id for splash; repo/path or repo:file for thengine).
// `tokenizer` is only meaningful for thengine (GGUF repos ship no
// tokenizer.json — the catalog carries the sibling base repo).
func (b Backend) SpawnArgs(model, tokenizer string, maxMemoryGB, maxContextK int) []string {
	if b.ID == "splash" {
		args := []string{"serve", "--model", model}
		if maxMemoryGB > 0 {
			args = append(args, "--max-memory", fmt.Sprintf("%dG", maxMemoryGB))
		}
		if maxContextK > 0 {
			args = append(args, "--max-context", fmt.Sprintf("%dK", maxContextK))
		}
		return args
	}
	// thengine
	args := []string{"serve", "--model", model, "--port", fmt.Sprintf("%d", b.Port)}
	if tokenizer != "" {
		args = append(args, "--tokenizer", tokenizer)
	}
	if maxContextK > 0 {
		args = append(args, "--max-context", fmt.Sprintf("%d", maxContextK*1024))
	}
	return args
}

var (
	Splash = Backend{
		ID: "splash", DisplayName: "Splash", Port: 8000,
		BinaryEnvVar: "TOKEN_HORIZON_SPLASH_BIN",
		BinarySearchPath: []string{
			"/opt/homebrew/bin/splash", "/usr/local/bin/splash",
		},
	}
	THEngine = Backend{
		ID: "thengine", DisplayName: "TH Engine", Port: 8001,
		BinaryEnvVar: "TOKEN_HORIZON_TH_ENGINE_BIN",
		BinarySearchPath: []string{
			// sibling of the daemon binary (release bundle), cargo bin
			"th-engine",
			filepath.Join(platform.HomeDir(), ".cargo", "bin", "th-engine"),
			"/opt/homebrew/bin/th-engine",
		},
	}
)

// Backend supervisor states — same wire strings as the Swift side.
const (
	StateStopped  = "stopped"
	StateStarting = "starting"
	StateServing  = "serving"
	StateFailed   = "failed"
)

type supervisorState struct {
	State    string `json:"state"`
	Model    string `json:"model,omitempty"`
	PID      int    `json:"pid,omitempty"`
	Attached bool   `json:"attached,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Supervisor manages one backend: probe, attach-or-spawn, stop-own-child.
type Supervisor struct {
	backend Backend

	mu      sync.Mutex
	state   supervisorState
	status  map[string]any // last /status payload
	lastErr string
	proc    *exec.Cmd // non-nil only while we own a spawned child
	client  *http.Client
}

func NewSupervisor(b Backend) *Supervisor {
	return &Supervisor{backend: b, state: supervisorState{State: StateStopped},
		client: &http.Client{Timeout: 600 * time.Millisecond}}
}

// Binary resolves the backend executable: env override → search paths → PATH.
func (s *Supervisor) Binary() string {
	if v := os.Getenv(s.backend.BinaryEnvVar); v != "" {
		if fi, err := os.Stat(v); err == nil && !fi.IsDir() {
			return v
		}
	}
	for _, p := range s.backend.BinarySearchPath {
		if p == "" {
			continue
		}
		// bare name → PATH lookup; path → stat
		if filepath.Base(p) == p {
			if r, err := exec.LookPath(p); err == nil {
				return r
			}
			continue
		}
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

func (s *Supervisor) EngineAvailable() bool { return s.Binary() != "" }

// probe GETs /status on the backend port. Returns the payload when a server
// answers and updates state accordingly.
func (s *Supervisor) probe() map[string]any {
	url := fmt.Sprintf("http://127.0.0.1:%d/status", s.backend.Port)
	resp, err := s.client.Get(url)
	var payload map[string]any
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == 200 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			var obj map[string]any
			if json.Unmarshal(body, &obj) == nil && obj["instance"] != nil {
				payload = obj
			}
		}
	}

	s.mu.Lock()
	spawnedPID := 0
	if s.proc != nil && s.proc.Process != nil && s.proc.ProcessState == nil {
		spawnedPID = s.proc.Process.Pid
	}
	if payload != nil {
		s.status = payload
		inst, _ := payload["instance"].(map[string]any)
		model, _ := inst["model"].(string)
		if model == "" {
			model = "?"
		}
		pid := spawnedPID
		if f, ok := inst["pid"].(float64); ok && f > 0 {
			pid = int(f)
		}
		s.state = supervisorState{State: StateServing, Model: model, PID: pid,
			Attached: spawnedPID == 0}
	} else {
		s.status = nil
		if s.state.State == StateServing {
			s.state = supervisorState{State: StateStopped}
		}
	}
	s.mu.Unlock()
	return payload
}

// Refresh re-probes once (called by the manager's poll loop).
func (s *Supervisor) Refresh() { s.probe() }

// Serve starts a model. If a server already answers on the backend's port we
// adopt it instead of double-serving.
func (s *Supervisor) Serve(model, tokenizer string, maxMemoryGB, maxContextK int) {
	s.mu.Lock()
	busy := s.state.State == StateStarting || s.state.State == StateServing
	s.mu.Unlock()
	if busy {
		return
	}
	go func() {
		if s.probe() != nil {
			return // adopted a foreign server
		}
		s.spawnServe(model, tokenizer, maxMemoryGB, maxContextK)
	}()
}

// Stop terminates only a server we spawned; an adopted one belongs to
// whoever ran it.
func (s *Supervisor) Stop() {
	s.mu.Lock()
	proc := s.proc
	s.proc = nil
	s.mu.Unlock()
	if proc != nil && proc.Process != nil {
		_ = proc.Process.Kill()
	}
	s.mu.Lock()
	s.state = supervisorState{State: StateStopped}
	s.status = nil
	s.mu.Unlock()
}

// Shutdown stops polling-owned state and any spawned child.
func (s *Supervisor) Shutdown() { s.Stop() }

// Payload is the per-backend GET /engine object — same keys as Swift.
func (s *Supervisor) Payload() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	stateObj := map[string]any{"state": s.state.State}
	switch s.state.State {
	case StateStarting:
		stateObj["model"] = s.state.Model
	case StateServing:
		stateObj["model"] = s.state.Model
		stateObj["pid"] = s.state.PID
		stateObj["attached"] = s.state.Attached
	case StateFailed:
		stateObj["error"] = s.state.Error
	}
	var bin any
	if b := s.Binary(); b != "" {
		bin = b
	}
	var eng, lastErr any
	if s.status != nil {
		eng = s.status
	}
	if s.lastErr != "" {
		lastErr = s.lastErr
	}
	return map[string]any{
		"id":            s.backend.ID,
		"name":          s.backend.DisplayName,
		"supervisor":    stateObj,
		"engine_binary": bin,
		"port":          s.backend.Port,
		"engine":        eng,
		"last_error":    lastErr,
	}
}

func (s *Supervisor) spawnServe(model, tokenizer string, maxMemoryGB, maxContextK int) {
	bin := s.Binary()
	if bin == "" {
		s.fail(s.backend.ID + " not installed")
		return
	}
	args := s.backend.SpawnArgs(model, tokenizer, maxMemoryGB, maxContextK)

	cmd := exec.Command(bin, args...)
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	for k, v := range s.backend.SpawnEnv {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	// Engine log: ~/.config/token-horizon/logs/ (Linux/Windows) mirrors the
	// macOS ~/Library/Logs convention.
	logDir := filepath.Join(platform.ConfigDir(), "logs")
	_ = os.MkdirAll(logDir, 0o755)
	logPath := filepath.Join(logDir, "token-horizon-engine-"+s.backend.ID+".log")
	if fh, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		cmd.Stdout, cmd.Stderr = fh, fh
		defer fh.Close()
	}

	if err := cmd.Start(); err != nil {
		s.fail("spawn failed: " + err.Error())
		return
	}
	s.mu.Lock()
	s.proc = cmd
	s.state = supervisorState{State: StateStarting, Model: model}
	s.mu.Unlock()
	log.Printf("engine supervisor: spawned %s serve %s", s.backend.ID, model)

	// Reap the child in the background so ProcessState fills in and an
	// early exit flips state to failed.
	go func() {
		err := cmd.Wait()
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.proc == cmd {
			s.proc = nil
			if s.state.State == StateStarting && s.state.Model == model {
				s.state = supervisorState{State: StateFailed,
					Error: fmt.Sprintf("%s exited during startup — see %s", s.backend.ID, logPath)}
				s.lastErr = s.state.Error
			}
			_ = err
		}
	}()

	// First-serve model downloads can take a very long time (~20 GB):
	// poll until the server answers or the child dies. ~30 min ceiling.
	for i := 0; i < 360; i++ {
		if s.probe() != nil {
			return
		}
		s.mu.Lock()
		alive := s.proc != nil && s.proc.ProcessState == nil
		s.mu.Unlock()
		if !alive {
			return
		}
		time.Sleep(5 * time.Second)
	}
	s.fail("timed out waiting for " + s.backend.ID + " to come up")
}

func (s *Supervisor) fail(msg string) {
	log.Printf("engine supervisor: %s", msg)
	s.mu.Lock()
	s.state = supervisorState{State: StateFailed, Error: msg}
	s.lastErr = msg
	s.mu.Unlock()
}

// ---- Installed-model detection (Splash packaged layout) ----

// SplashInstalledModelIDs reports owner/repo dirs under the Splash model
// roots. We only report installed-ness — the engine remains the authority
// on whether a snapshot is complete and verified.
func SplashInstalledModelIDs() map[string]bool {
	home := platform.HomeDir()
	roots := []string{
		filepath.Join(home, "Library", "Application Support", "Splash", "models"),
		filepath.Join(home, ".local", "share", "Splash", "models"), // Linux convention
		"/opt/homebrew/libexec/install/models",
		"/usr/local/libexec/install/models",
	}
	found := map[string]bool{}
	for _, root := range roots {
		owners, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, owner := range owners {
			if !owner.IsDir() {
				continue
			}
			repos, err := os.ReadDir(filepath.Join(root, owner.Name()))
			if err != nil {
				continue
			}
			for _, repo := range repos {
				if repo.IsDir() {
					found[owner.Name()+"/"+repo.Name()] = true
				}
			}
		}
	}
	return found
}
