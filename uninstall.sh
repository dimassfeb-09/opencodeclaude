#!/usr/bin/env sh
# uninstall.sh - remove opencodeclaude (Linux / macOS).
# Run locally:  ./uninstall.sh
# Or hosted:    sh -c "$(curl -fsSL https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main/uninstall.sh)"
set -e

Dest="${XDG_DATA_HOME:-$HOME/.local/share}/opencodeclaude"
BinDir="${XDG_BIN_HOME:-$HOME/.local/bin}"
ConfigDir="${XDG_CONFIG_HOME:-$HOME/.config}/opencodeclaude"

# Stop any proxy still listening on the default port.
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -ti tcp:3456 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
fi

rm -f "$BinDir/opencodeclaude"
rm -rf "$Dest" "$ConfigDir"

echo 'opencodeclaude uninstalled.'
