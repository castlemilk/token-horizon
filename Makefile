# Token Horizon — developer entry points.
#
# `./scripts/make-app.sh` remains the ONLY supported launcher (it stamps
# THGitSHA/THBuiltAt, syncs /Applications, health-gates :8765). This Makefile
# is for fast inner-loop checks: lint, tests (incl. TSan, the `go test -race`
# analogue), and plain builds. It never launches the app.

SWIFT := swift
SWIFTLINT := swiftlint

.PHONY: lint test test-race build app bench perf-test profile profile-sample help

help:
	@echo "Targets: lint | test | test-race | build | app | bench | perf-test | profile | profile-sample"

lint:
	@if ! command -v $(SWIFTLINT) >/dev/null 2>&1; then \
		echo "swiftlint not found. Install with: brew install swiftlint"; exit 1; fi
	$(SWIFTLINT) lint

# Full XCTest suite (unit + budget-gated perf + integration).
test:
	$(SWIFT) test

# Thread-sanitized run — the `go test -race ./...` analogue. Slower; run
# before merging concurrency-adjacent changes (engine locks, timers, proxy).
test-race:
	$(SWIFT) test --sanitize=thread

build:
	$(SWIFT) build

# Canonical release-style build + install + relaunch (health-gated).
app:
	./scripts/make-app.sh

bench:
	./scripts/bench-models.sh

perf-test:
	./scripts/test-models-perf.sh

# Repeatable tick profiler (timing table; machine-dependent, no assertions).
profile:
	./scripts/profile-tick.sh

# Timing table + 20s `sample` hotspot profile (/tmp/th-tick-profile.txt).
profile-sample:
	./scripts/profile-tick.sh --sample
