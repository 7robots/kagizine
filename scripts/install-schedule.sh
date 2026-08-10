#!/bin/sh
# Install (or reinstall) the daily 08:15 fetch as a user LaunchAgent.
#
# Idempotent: bootout first, then bootstrap, so re-running after an edit to the
# plist actually takes effect rather than silently keeping the loaded copy.
#
# Remove it again with:
#   launchctl bootout gui/$(id -u)/com.kagi-news.magazine
#   rm ~/Library/LaunchAgents/com.kagi-news.magazine.plist
set -eu

LABEL=com.kagi-news.magazine
PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
UV_PATH=$(command -v uv || echo "$HOME/.local/bin/uv")
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -x "$UV_PATH" ]; then
  echo "uv not found; install it first (https://docs.astral.sh/uv/)" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs" "$HOME/Library/LaunchAgents"

sed -e "s|PROJECT_DIR|$PROJECT_DIR|g" -e "s|UV_PATH|$UV_PATH|g" \
  "$PROJECT_DIR/scripts/$LABEL.plist" >"$TARGET"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"

echo "Installed $LABEL -- fetches daily at 08:15."
echo "  log:     $PROJECT_DIR/logs/fetch.log"
echo "  run now: launchctl kickstart -k gui/$(id -u)/$LABEL"
