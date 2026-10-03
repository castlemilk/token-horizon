package limits

import (
	"bytes"
	"os/exec"

	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

// execCommand runs a command and returns stdout (temp-file pattern is
// unnecessary in Go — pipes don't deadlock here).
func ExecCommand(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	platform.HideConsole(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return out.String(), nil
}
