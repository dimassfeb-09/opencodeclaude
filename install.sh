#!/usr/bin/env sh
# install.sh - one-time install of opencodeclaude (Linux / macOS).
# Requires: Node.js 20+ and the `claude` CLI. No PowerShell / pwsh needed.
# Run locally:  ./install.sh
# Or hosted:
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main/install.sh)"
set -e

RepoUrl='https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main'
Dest="${XDG_DATA_HOME:-$HOME/.local/share}/opencodeclaude"
BinDir="${XDG_BIN_HOME:-$HOME/.local/bin}"
Src="$(cd "$(dirname "$0")" && pwd)"

# Fail fast with clear guidance instead of a cryptic error at first run.
for cmd in node claude; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found on PATH."
    echo "  node   - install Node.js 20+ (e.g. brew install node)"
    echo "  claude - install Claude Code: https://docs.claude.com/en/docs/claude-code"
    exit 1
  fi
done

mkdir -p "$Dest"
if [ -f "$Src/cli.mjs" ] && [ -f "$Src/proxy.mjs" ]; then
  cp "$Src/cli.mjs" "$Src/proxy.mjs" "$Dest/"
else
  for f in cli.mjs proxy.mjs; do
    echo "Downloading $f ..."
    curl -fsSL "$RepoUrl/$f" -o "$Dest/$f"
  done
fi

mkdir -p "$BinDir"
cat > "$BinDir/opencodeclaude" <<EOF
#!/usr/bin/env sh
exec node "$Dest/cli.mjs" "\$@"
EOF
chmod +x "$BinDir/opencodeclaude"

echo ''
echo 'opencodeclaude installed.'
echo "  Files: $Dest"
echo "  Shim:  $BinDir/opencodeclaude"
echo ''
echo "Add $BinDir to PATH if missing, then run: opencodeclaude"
echo 'First run asks for your OpenCode plan and API key (https://opencode.ai/auth).'
