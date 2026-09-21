package files

import "testing"

// Verify against Swift-written rows in the real production DB:
// 01F88E31-1C0B-E062-2D4E-8A51BE3FD5C3 = backfill|kimi|1782600900 (ts 1782601050 - 150)
func TestBackfillUUIDMatchesSwift(t *testing.T) {
	got := backfillUUID("kimi", 1782600900)
	want := "01F88E31-1C0B-E062-2D4E-8A51BE3FD5C3"
	if got != want {
		t.Fatalf("uuid parity with Swift: got %s want %s", got, want)
	}
	got2 := backfillUUID("claude", 1778748450-150)
	want2 := "92FDEB22-31AA-8B74-A9EC-6EA3065CC66B"
	if got2 != want2 {
		t.Fatalf("uuid parity 2: got %s want %s", got2, want2)
	}
}
