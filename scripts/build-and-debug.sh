#!/usr/bin/env bash
# Build the plugin and launch Joplin with Chrome DevTools Protocol enabled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

DEBUG_PORT="${JOPLIN_DEBUG_PORT:-9222}"
TEST_PROFILE="${JOPLIN_TEST_PROFILE:-$HOME/.joplin-slidev-test-profile}"
PLUGIN_DIR="$TEST_PROFILE/plugins"

echo "==> Installing dependencies..."
npm install

echo "==> Building plugin..."
npm run dist

JPL_FILE="$(ls "$PROJECT_DIR/publish/"*.jpl 2>/dev/null | head -1)"
if [ -z "$JPL_FILE" ]; then
  echo "ERROR: No .jpl file found in publish/ — build may have failed."
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
rm -f "$PLUGIN_DIR/"*.jpl

echo "==> Installing plugin to test profile: $PLUGIN_DIR"
cp "$JPL_FILE" "$PLUGIN_DIR/"

echo "==> Launching Joplin with profile: $TEST_PROFILE"
echo "==> Electron remote debugging: http://127.0.0.1:$DEBUG_PORT/json/list"

if [[ "$(uname)" == "Darwin" ]]; then
  open -a "Joplin" --args \
    --profile "$TEST_PROFILE" \
    --remote-debugging-port="$DEBUG_PORT"
else
  STARTED=0
  for BIN in joplin /usr/bin/joplin "$HOME/.joplin/Joplin" "$HOME/Applications/Joplin.AppImage"; do
    if command -v "$BIN" &>/dev/null || [ -x "$BIN" ]; then
      "$BIN" \
        --profile "$TEST_PROFILE" \
        --remote-debugging-port="$DEBUG_PORT" &
      STARTED=1
      break
    fi
  done
  if [ "$STARTED" -eq 0 ]; then
    echo "ERROR: Could not find Joplin binary."
    exit 1
  fi
fi

echo "==> Done. Joplin is starting with remote debugging enabled."
