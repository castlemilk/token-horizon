package mitm

// Fidelity tests for the MITM subsystem: addon UA-table agreement with the
// point-mode meter (the drift invariant), vendor host scoping, consent
// gating, and the status checklist.

import (
	"strings"
	"testing"

	"github.com/castlemilk/token-horizon/daemons/go/internal/meter"
)

func TestAddonUATableAgreesWithMeter(t *testing.T) {
	src := Source()
	for _, row := range meter.UATable() {
		needle := `("` + row[0] + `", "` + row[1] + `")`
		if !strings.Contains(src, needle) {
			t.Errorf("addon missing UA row %s (meter/mitm drift)", needle)
		}
	}
}

func TestAddonScoping(t *testing.T) {
	src := Source()
	// Vendor hosts present; passthrough for everything else.
	for _, host := range []string{
		"api.anthropic.com", "api.openai.com", "chatgpt.com",
		"api.moonshot.cn", "open.bigmodel.cn", "api.minimax.io",
		"generativelanguage.googleapis.com", "dashscope.aliyuncs.com",
		"api.deepseek.com", "opencode.ai",
	} {
		if !strings.Contains(src, `"`+host+`"`) {
			t.Errorf("vendor host %s missing from addon", host)
		}
	}
	if !strings.Contains(src, "data.ignore_connection = True") {
		t.Error("non-vendor SNI must pass through undecrypted")
	}
	if !strings.Contains(src, `for port in range(8765, 8785)`) {
		t.Error("loopback API discovery over 8765..8784")
	}
}

func TestManagerConsentGate(t *testing.T) {
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	t.Setenv("TH_CONSENT", "") // no consent at all
	m := NewManager()
	m.Start()
	if m.IsRunning() {
		t.Fatal("mitm must never start without .mitm consent")
	}
	status := m.Status()
	if status["consented"] != false {
		t.Fatal("status reports consent state")
	}
	steps := status["next_steps"].([]string)
	found := false
	for _, s := range steps {
		if strings.Contains(s, "TH_CONSENT=mitm") {
			found = true
		}
	}
	if !found {
		t.Errorf("status must list the consent remediation: %v", steps)
	}
}

func TestStatusShape(t *testing.T) {
	t.Setenv("TH_CONFIG_DIR", t.TempDir())
	m := NewManager()
	status := m.Status()
	for _, key := range []string{"mode", "consented", "running", "listen",
		"ca_generated", "ca_trusted", "scope", "next_steps"} {
		if _, ok := status[key]; !ok {
			t.Errorf("status missing key %s", key)
		}
	}
	if status["listen"] != "127.0.0.1:9871" {
		t.Errorf("listen: %v", status["listen"])
	}
}
