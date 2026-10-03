package service

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestStartupGeneratorsQuotePaths(t *testing.T) {
	path := "/home/test user/100%/Token Horizon"
	if got := SystemdUnit(path); !strings.Contains(got, `ExecStart="/home/test user/100%%/Token Horizon"`) {
		t.Fatalf("systemd command does not preserve spaces or percent signs: %s", got)
	}
	if got := AutostartDesktop(path); !strings.Contains(got, `Exec="/home/test user/100%%/Token Horizon"`) {
		t.Fatalf("desktop command does not preserve spaces or percent signs: %s", got)
	}
	if got := WindowsRunCommand(`C:\Users\Test User\Token Horizon\token-horizon-daemon.exe`); got != `"C:\Users\Test User\Token Horizon\token-horizon-daemon.exe"` {
		t.Fatalf("Windows startup command = %s", got)
	}
}

func TestLaunchAgentEscapesPaths(t *testing.T) {
	data := LaunchAgentPlist("test<&>", "/tmp/token & horizon", "/tmp/usage<log>")
	var plist any
	if err := xml.Unmarshal([]byte(data), &plist); err != nil {
		t.Fatalf("invalid plist XML: %v", err)
	}
	if !strings.Contains(data, "token &amp; horizon") || !strings.Contains(data, "usage&lt;log&gt;") {
		t.Fatalf("paths must be XML escaped: %s", data)
	}
}
