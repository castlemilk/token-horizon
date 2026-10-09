package main

import (
	"bytes"
	"encoding/json"
)

// streamMetadata observes complete SSE/NDJSON lines independently of the
// bounded trace-body prefix. It keeps counters/IDs, never generated text.
// Oversized frames are skipped explicitly; forwarding is always unchanged.
type streamMetadata struct {
	line       []byte
	dropping   bool
	skipped    bool
	complete   bool
	model      string
	responseID string
	frames     map[string][]byte
}

func (s *streamMetadata) write(b []byte) {
	for len(b) > 0 {
		n := bytes.IndexByte(b, '\n')
		end := n
		if end < 0 {
			end = len(b)
		}
		if !s.dropping {
			if len(s.line)+end > BodyCapBytes {
				s.line = nil
				s.dropping = true
				s.skipped = true
			} else {
				s.line = append(s.line, b[:end]...)
			}
		}
		if n < 0 {
			return
		}
		if !s.dropping {
			s.observe(s.line)
		}
		s.line = nil
		s.dropping = false
		b = b[n+1:]
	}
}

func (s *streamMetadata) observe(line []byte) {
	line = bytes.TrimSpace(line)
	line = bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
	if bytes.Equal(line, []byte("[DONE]")) {
		s.complete = true
		return
	}
	var obj map[string]any
	if json.Unmarshal(line, &obj) != nil {
		return
	}
	kind, _ := obj["type"].(string)
	if kind == "response.completed" || kind == "message_stop" || obj["done"] == true {
		s.complete = true
	}
	metadata := map[string]any{}
	for _, key := range []string{"type", "id", "model", "usage", "usageMetadata", "done", "prompt_eval_count", "eval_count", "stop_reason"} {
		if v, ok := obj[key]; ok {
			metadata[key] = v
		}
	}
	for _, key := range []string{"response", "message"} {
		if child := strMap(obj[key]); child != nil {
			clean := map[string]any{}
			for _, field := range []string{"id", "model", "usage", "status", "stop_reason"} {
				if v, ok := child[field]; ok {
					clean[field] = v
				}
			}
			metadata[key] = clean
			if m, _ := child["model"].(string); m != "" {
				s.model = m
			}
			if id, _ := child["id"].(string); id != "" {
				s.responseID = id
			}
		}
	}
	if m, _ := obj["model"].(string); m != "" {
		s.model = m
	}
	if id, _ := obj["id"].(string); id != "" {
		s.responseID = id
	}
	// Content deltas do not consume the bounded metadata store. Provider
	// usage frames replace their earlier snapshot rather than counting twice.
	hasUsage := obj["usage"] != nil || obj["usageMetadata"] != nil || obj["eval_count"] != nil || strMap(obj["response"])["usage"] != nil || strMap(obj["message"])["usage"] != nil
	if !hasUsage {
		return
	}
	key := kind
	if key == "" {
		key = "usage"
	}
	// Fixed wire vocabulary keeps an upstream from creating unlimited keys.
	switch key {
	case "usage", "message_start", "message_delta", "response.completed", "response.incomplete", "response.failed":
	default:
		key = "usage"
	}
	data, err := json.Marshal(metadata)
	if err != nil || len(data) > 32*1024 {
		s.skipped = true
		return
	}
	if s.frames == nil {
		s.frames = map[string][]byte{}
	}
	s.frames[key] = data
}

func (s *streamMetadata) finish() []byte {
	if !s.dropping && len(s.line) > 0 {
		s.observe(s.line)
	}
	var out []byte
	for _, key := range []string{"message_start", "message_delta", "usage", "response.incomplete", "response.failed", "response.completed"} {
		if data := s.frames[key]; data != nil {
			out = append(out, data...)
			out = append(out, '\n')
		}
	}
	return out
}
