#!/bin/bash
# Build the NanoClaw local agent-runner bundle

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_RUNNER_DIR="$SCRIPT_DIR/agent-runner"

echo "Building NanoClaw local agent runner..."
echo "Project root: ${PROJECT_ROOT}"

cd "$AGENT_RUNNER_DIR"

if [[ ! -d node_modules ]]; then
	echo "Installing agent-runner dependencies..."
	npm install
fi

npm run build

echo ""
echo "Local agent runner build complete: ${AGENT_RUNNER_DIR}/dist/index.js"
