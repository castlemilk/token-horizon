package system

import "testing"

func TestParseElapsed(t *testing.T) {
	for _, tc := range []struct {
		text string
		want float64
	}{{"02:03", 123}, {"04:02:03", 14523}, {"1-04:02:03", 100923}, {"2-00:00:00", 172800}} {
		t.Run(tc.text, func(t *testing.T) {
			if got := parseElapsed(tc.text); got != tc.want {
				t.Fatalf("elapsed = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestWindowsProcessJSON(t *testing.T) {
	const row = `{"pid":42,"ppid":7,"name":"python.exe","command":"python.exe --mlx-engine","threads":3,"workingSetBytes":1048576,"cpuSeconds":12.5,"startTime":1789700000}`
	for _, tc := range []struct {
		name string
		data string
		want int
	}{{"array", "[" + row + "]", 1}, {"single object", row, 1}, {"utf8 bom", "\xef\xbb\xbf" + row, 1}, {"empty array", "[]", 0}, {"null", "null", 0}, {"empty output", "", 0}} {
		t.Run(tc.name, func(t *testing.T) {
			rows, err := decodeWindowsProcesses([]byte(tc.data))
			if err != nil || len(rows) != tc.want {
				t.Fatalf("rows=%+v err=%v", rows, err)
			}
			if len(rows) > 0 && (rows[0].Threads != 3 || rows[0].PPID != 7 || rows[0].StartTime != 1789700000 || rows[0].Command != "python.exe --mlx-engine") {
				t.Fatalf("lost process telemetry: %+v", rows[0])
			}
		})
	}
	if _, err := decodeWindowsProcesses([]byte(`{"threads":[]}`)); err == nil {
		t.Fatal("unexpected collection must surface a decoding error")
	}
}
