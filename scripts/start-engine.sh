#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR/engine"

echo "Starting Token Horizon Micro Agent Workflow Engine..."
RUN_SERVER=true npm start
