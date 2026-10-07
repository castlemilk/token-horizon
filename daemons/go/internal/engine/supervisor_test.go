package engine

import (
	"reflect"
	"testing"
)

func TestSpawnArgsLifecycle(t *testing.T) {
	for _, tt := range []struct {
		name       string
		backend    Backend
		keepLoaded bool
		want       []string
	}{
		{"idle by default", THEngine, false, []string{"serve", "--model", "test/model", "--port", "8001", "--idle-timeout-secs", "300", "--tokenizer", "test/tokenizer", "--max-context", "8192"}},
		{"explicit keep loaded", THEngine, true, []string{"serve", "--model", "test/model", "--port", "8001", "--idle-timeout-secs", "0", "--tokenizer", "test/tokenizer", "--max-context", "8192"}},
		{"splash unchanged", Splash, true, []string{"serve", "--model", "test/model", "--max-memory", "16G", "--max-context", "8K"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.backend.SpawnArgs("test/model", "test/tokenizer", 16, 8, tt.keepLoaded)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("SpawnArgs = %q, want %q", got, tt.want)
			}
		})
	}
}
