package system

import (
	"bytes"
	"encoding/json"
)

// Powershell emits a single JSON object when only one process is visible.
// Keep its decoding platform-neutral so this contract is checked on all CI hosts.
type windowsProcess struct {
	PID             int32   `json:"pid"`
	PPID            int32   `json:"ppid"`
	Name            string  `json:"name"`
	Command         string  `json:"command"`
	Threads         int     `json:"threads"`
	WorkingSetBytes float64 `json:"workingSetBytes"`
	CPUSeconds      float64 `json:"cpuSeconds"`
	StartTime       int64   `json:"startTime"`
}

func decodeWindowsProcesses(data []byte) ([]windowsProcess, error) {
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))
	if len(data) == 0 || bytes.Equal(data, []byte("null")) {
		return nil, nil
	}
	var rows []windowsProcess
	if data[0] == '[' {
		err := json.Unmarshal(data, &rows)
		return rows, err
	}
	var row windowsProcess
	if err := json.Unmarshal(data, &row); err != nil {
		return nil, err
	}
	return []windowsProcess{row}, nil
}
