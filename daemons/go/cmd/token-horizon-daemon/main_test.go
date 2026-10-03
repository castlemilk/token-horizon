package main

import (
	"context"
	"io"
	"testing"
	"time"
)

func TestDesktopOwnershipEndsOnPipeEOF(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader, writer := io.Pipe()
	defer reader.Close()
	done := make(chan struct{})
	go func() {
		cancelOnEOF(ctx, reader, cancel)
		close(done)
	}()
	if _, err := writer.Write([]byte("parent still owns daemon")); err != nil {
		t.Fatal(err)
	}
	if ctx.Err() != nil {
		t.Fatal("input bytes must not end desktop ownership")
	}
	writer.Close()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("closing parent pipe must cancel the daemon")
	}
	<-done
}
