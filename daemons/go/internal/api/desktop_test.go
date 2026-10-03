package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/castlemilk/token-horizon/daemons/go/internal/cloudsync"
	"github.com/castlemilk/token-horizon/daemons/go/internal/platform"
)

func TestHealthCarriesDesktopBuildIdentity(t *testing.T) {
	st := testStore(t)
	server := &apiServer{store: st, start: time.Now()}
	w := httptest.NewRecorder()
	server.mux().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	var body struct {
		OK         bool               `json:"ok"`
		Name       string             `json:"name"`
		UsageStore bool               `json:"usage_store"`
		Build      platform.BuildInfo `json:"build"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || !body.UsageStore || body.Name != "token-horizon-daemon" || body.Build != platform.Build() {
		t.Fatalf("unexpected desktop health identity: %+v", body)
	}
}

func TestListenRejectsOccupiedPort(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port
	ln, actual, err := listen(port)
	if ln != nil {
		ln.Close()
	}
	if err == nil || ln != nil || actual != 0 {
		t.Fatalf("occupied port must fail without hopping: listener=%v port=%d err=%v", ln, actual, err)
	}
}

func TestDaemonContextClosesListener(t *testing.T) {
	st := testStore(t)
	reserved, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := reserved.Addr().(*net.TCPAddr).Port
	reserved.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	daemon := &Daemon{Store: st, Syncer: cloudsync.NewSyncer()}
	done := make(chan error, 1)
	go func() { done <- daemon.RunContext(ctx, port, nil) }()
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/health"
	client := &http.Client{Timeout: 100 * time.Millisecond}
	deadline := time.Now().Add(2 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		if res, err := client.Get(url); err == nil {
			res.Body.Close()
			ready = res.StatusCode == http.StatusOK
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		t.Fatal("daemon did not bind its configured port")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("desktop cancellation did not return through cleanup")
	}
	if res, err := client.Get(url); err == nil {
		res.Body.Close()
		t.Fatal("API listener remained available after cancellation")
	}
}
