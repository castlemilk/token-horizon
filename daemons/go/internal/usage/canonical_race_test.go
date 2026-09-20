package usage

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Regression for the fatal "concurrent map iteration and map write":
// VendorCASE used to alias vendorTable and write overrides into it while
// other goroutines iterated; the override loader also unmarshalled into the
// live cache map. Hammer reads while toggling canonical.json — under -race
// this fails loudly if either pattern regresses.
func TestCanonicalConcurrentOverrideReload(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	path := filepath.Join(dir, "canonical.json")

	var wg sync.WaitGroup
	stop := time.Now().Add(300 * time.Millisecond)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(stop) {
				_ = VendorCASE("vendor")
				_ = Vendor("Anthropic")
				_ = Model("claude", "Claude-Opus-4.1@foo")
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		flip := false
		for time.Now().Before(stop) {
			flip = !flip
			content := `{"vendors":{"anthropic":"claude"}}`
			if flip {
				content = `{"vendors":{"anthropic":"claude","acme":"acme-ai"},"models":{"claude/x":"claude-y"}}`
			}
			_ = os.WriteFile(path, []byte(content), 0o644)
			// Force past the 5s TTL by re-writing with a changing mtime;
			// mtime changes are what trigger reloads.
			time.Sleep(time.Millisecond)
		}
	}()
	wg.Wait()
}

// The built-in table must never be mutated by override overlays.
func TestVendorCASEDoesNotMutateBuiltinTable(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TH_CONFIG_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "canonical.json"),
		[]byte(`{"vendors":{"zzz-custom":"acme"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	before := len(vendorTable)
	_ = VendorCASE("vendor")
	if len(vendorTable) != before {
		t.Fatalf("vendorTable grew: %d -> %d", before, len(vendorTable))
	}
	if _, ok := vendorTable["zzz-custom"]; ok {
		t.Fatal("override leaked into the built-in vendorTable")
	}
}
