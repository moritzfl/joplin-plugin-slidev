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

JPL_FILE="$PROJECT_DIR/publish/de.moritzf.slidev-integration.jpl"
if [ ! -f "$JPL_FILE" ]; then
  echo "ERROR: No .jpl file found in publish/ — build may have failed."
  exit 1
fi

# Set up an isolated Joplin test profile.
TEST_PROFILE="$HOME/.joplin-slidev-test-profile"
PLUGIN_DIR="$TEST_PROFILE/plugins"
mkdir -p "$PLUGIN_DIR"

# Remove any previous version of this plugin so there are no stale copies.
rm -f "$PLUGIN_DIR/de.moritzf.slidev-integration.jpl"

echo "==> Installing plugin to test profile: $PLUGIN_DIR"
cp "$JPL_FILE" "$PLUGIN_DIR/"

echo "==> Launching Joplin with profile: $TEST_PROFILE"
if [[ "$(uname)" == "Darwin" ]]; then
  # macOS: use 'open' to pass args through to the app bundle.
  open -a "Joplin" --args --profile "$TEST_PROFILE"
else
  # Linux / other: try common binary locations.
  STARTED=0
  for BIN in joplin /usr/bin/joplin "$HOME/.joplin/Joplin" "$HOME/Applications/Joplin.AppImage"; do
    if command -v "$BIN" &>/dev/null || [ -x "$BIN" ]; then
      "$BIN" --profile "$TEST_PROFILE" &
      STARTED=1
      break
    fi
  done
  if [ "$STARTED" -eq 0 ]; then
    echo "ERROR: Could not find Joplin binary."
    exit 1
  fi
fi

echo "==> Done. Joplin is starting with the test profile."
