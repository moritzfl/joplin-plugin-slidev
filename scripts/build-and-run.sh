#!/usr/bin/env bash
# Build the plugin and launch Joplin with a fresh test profile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Installing dependencies..."
npm install

echo "==> Building plugin..."
npm run dist

# Locate the built .jpl file.
JPL_FILE="$(ls "$PROJECT_DIR/publish/"*.jpl 2>/dev/null | head -1)"
if [ -z "$JPL_FILE" ]; then
  echo "ERROR: No .jpl file found in publish/ — build may have failed."
  exit 1
fi

# Set up an isolated Joplin test profile.
TEST_PROFILE="$HOME/.joplin-slidev-test-profile"
PLUGIN_DIR="$TEST_PROFILE/plugins"
mkdir -p "$PLUGIN_DIR"

# Remove any previous version of this plugin so there are no stale copies.
rm -f "$PLUGIN_DIR/"*.jpl

echo "==> Installing plugin to test profile: $PLUGIN_DIR"
cp "$JPL_FILE" "$PLUGIN_DIR/"

echo "==> Launching Joplin with profile: $TEST_PROFILE"
if [[ "$(uname)" == "Darwin" ]]; then
  # macOS: use 'open' to pass args through to the app bundle.
  open -a "Joplin" --args --profile "$TEST_PROFILE"
else
  # Linux / other: try common binary locations.
  for BIN in joplin /usr/bin/joplin "$HOME/.joplin/Joplin" "$HOME/Applications/Joplin.AppImage"; do
    if command -v "$BIN" &>/dev/null || [ -x "$BIN" ]; then
      "$BIN" --profile "$TEST_PROFILE" &
      break
    fi
  done
fi

echo "==> Done. Joplin is starting with the test profile."
