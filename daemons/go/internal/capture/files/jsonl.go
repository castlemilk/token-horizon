package files

// THE incremental JSONL reader (Usage/IncrementalJSONL.swift port) — one
// implementation for every file tailer (consolidators, backfill scanners).
//
// Semantics:
//   - consumes only bytes past offset, and only up to the LAST newline, so
//     a partially-written tail line survives unconsumed to the next poll;
//   - the stored offset advances by exactly the consumed byte count;
//   - truncation/rotation (file shrank below offset) restarts at 0 and
//     fires onTruncate BEFORE any line is delivered, so callers with
//     per-file accumulators can reset them.

import (
	"bytes"
	"io"
	"os"
)

// IncrementalRead consumes new complete lines from path. Returns false when
// nothing consumable exists (no new complete line).
func IncrementalRead(path string, offset *uint64, onTruncate func(), body func(line []byte)) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	size := uint64(info.Size())
	if size < *offset {
		*offset = 0
		onTruncate()
	}
	if size <= *offset {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if _, err := f.Seek(int64(*offset), 0); err != nil {
		return false
	}
	chunk, err := io.ReadAll(f)
	if err != nil {
		return false
	}
	lastNL := bytes.LastIndexByte(chunk, '\n')
	if lastNL < 0 {
		return false
	}
	consumable := chunk[:lastNL+1]
	for _, line := range bytes.Split(consumable, []byte{'\n'}) {
		if len(line) > 0 {
			body(line)
		}
	}
	*offset += uint64(len(consumable))
	return true
}
