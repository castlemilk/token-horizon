// Command devwatch is a zero-dependency hot-reload runner for the cloud
// server: it polls the source tree, rebuilds ./cmd/server on change, and
// restarts the server process (build failures keep the old binary alive).
//
// Usage (from cloud/server/):
//
//	go run ./cmd/devwatch            # build tag duckdb, temp binary
//	devwatch --tags "" --bin /tmp/x  # plain postgres build
//
// The server's configuration comes from the environment as usual
// (TH_SERVER_* / config file) — devwatch only owns build + lifecycle.
// Polled mtimes instead of fsnotify: no dependencies, works identically
// on macOS/Linux/Windows, and the tree is small enough that a 700ms walk
// costs nothing.
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

var skippedDirs = map[string]bool{
	".git": true, "data": true, "node_modules": true, ".dev-bin": true,
}

// snapshot returns a cheap fingerprint of every .go/.sql file under root:
// "count:latestModNano". Any add/delete/edit changes it.
func snapshot(root string) (string, error) {
	var files []string
	latest := int64(0)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skippedDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				if d.Name() != "." {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") && !strings.HasSuffix(d.Name(), ".sql") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		files = append(files, path)
		if n := info.ModTime().UnixNano(); n > latest {
			latest = n
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	return fmt.Sprintf("%d:%d", len(files), latest), nil
}

func build(root, tags, bin string) bool {
	args := []string{"build"}
	if tags != "" {
		args = append(args, "-tags", tags)
	}
	args = append(args, "-o", bin, "./cmd/server")
	cmd := exec.Command("go", args...)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[devwatch] build failed (keeping current server):\n%s\n", out)
		return false
	}
	return true
}

type serverProc struct {
	cmd *exec.Cmd
}

func (p *serverProc) start(bin string, args ...string) error {
	p.cmd = exec.Command(bin, args...)
	p.cmd.Stdout = os.Stdout
	p.cmd.Stderr = os.Stderr
	p.cmd.Env = os.Environ()
	return p.cmd.Start()
}

// stop terminates the child and WAITS for exit — DuckDB is single-writer,
// so the next server must not start until this one released the file.
func (p *serverProc) stop() {
	if p.cmd == nil || p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() { _, _ = p.cmd.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
		<-done
	}
}

func main() {
	tags := flag.String("tags", "duckdb", "go build tags (empty = none)")
	bin := flag.String("bin", filepath.Join(os.TempDir(), "token-horizon-cloud-dev"), "server binary path")
	interval := flag.Duration("interval", 700*time.Millisecond, "poll interval")
	flag.Parse()
	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[devwatch]", err)
		os.Exit(1)
	}

	sig, err := snapshot(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[devwatch] scan:", err)
		os.Exit(1)
	}
	if !build(root, *tags, *bin) {
		os.Exit(1)
	}
	proc := &serverProc{}
	if err := proc.start(*bin, flag.Args()...); err != nil {
		fmt.Fprintln(os.Stderr, "[devwatch] start:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[devwatch] serving %s — watching %s (poll %s)\n", *bin, root, *interval)

	// Forward termination to the child, then exit (run-dev teardown path).
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-interrupt
		proc.stop()
		os.Exit(0)
	}()

	for range time.Tick(*interval) {
		next, err := snapshot(root)
		if err != nil || next == sig {
			continue
		}
		// Debounce: wait until the tree is quiet for one interval, so a
		// multi-file save rebuilds once.
		time.Sleep(*interval)
		if quiet, _ := snapshot(root); quiet != next {
			continue
		}
		sig = next
		fmt.Fprintln(os.Stderr, "[devwatch] change detected — rebuilding…")
		if !build(root, *tags, *bin) {
			continue
		}
		proc.stop()
		if err := proc.start(*bin, flag.Args()...); err != nil {
			fmt.Fprintln(os.Stderr, "[devwatch] restart:", err)
		} else {
			fmt.Fprintln(os.Stderr, "[devwatch] restarted")
		}
	}
}
