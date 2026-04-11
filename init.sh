#!/usr/bin/env bash
# init.sh — Run at the start of every AI-assisted session.
# Restores the development environment and confirms readiness.

set -euo pipefail

echo "=== Harness Init ==="

# 1. Confirm git state
echo ""
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(unborn)')
last=$(git log -1 --oneline 2>/dev/null || echo '(no commits yet)')
echo "[git] Current branch: $branch"
echo "[git] Last commit:    $last"
git status --short

# 2. Show current progress
echo ""
echo "[progress]"
if [ -f claude-progress.txt ]; then
  cat claude-progress.txt
else
  echo "  (no progress file yet)"
fi

# 3. Show feature status
echo ""
echo "[features]"
if [ -f features.json ]; then
  # Pretty-print if jq is available, otherwise cat
  if command -v jq &>/dev/null; then
    jq '.' features.json
  else
    cat features.json
  fi
else
  echo "  (no features.json yet)"
fi

# 4. Install dependencies (customize per project)
# Uncomment the relevant block:

# --- Node.js ---
# if [ -f package.json ]; then
#   echo ""
#   echo "[deps] Installing Node packages..."
#   npm install
# fi

# --- Python ---
# if [ -f requirements.txt ]; then
#   echo ""
#   echo "[deps] Installing Python packages..."
#   pip install -r requirements.txt
# fi

# --- Go ---
# if [ -f go.mod ]; then
#   echo ""
#   echo "[deps] Downloading Go modules..."
#   go mod download
# fi

# 5. Run smoke tests (customize per project)
# Uncomment when tests exist:
# echo ""
# echo "[test] Running smoke tests..."
# npm test --silent 2>&1 | tail -5   # or: go test ./... / pytest -q

echo ""
echo "=== Ready ==="
