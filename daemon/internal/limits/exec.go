package limits

import (
	"bytes"
	"os/exec"
)

// execCommand runs a command and returns stdout (temp-file pattern is
// unnecessary in Go — pipes don't deadlock here).
func execCommand(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return out.String(), nil
}
