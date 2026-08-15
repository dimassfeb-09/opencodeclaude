#!/usr/bin/env sh
# install.sh - one-time install of opencodeclaude (Linux / macOS).
# Requires: pwsh (PowerShell 7+), the `claude` CLI, and Node.js 20+.
# Run locally:  ./install.sh
# Or hosted:
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main/install.sh)"
set -e

RepoUrl='https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main'
Dest="${XDG_DATA_HOME:-$HOME/.local/share}/opencodeclaude"
BinDir="${XDG_BIN_HOME:-$HOME/.local/bin}"
Src="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$Dest"
if [ -f "$Src/opencodeclaude.ps1" ] && [ -f "$Src/proxy.mjs" ]; then
  cp "$Src/opencodeclaude.ps1" "$Src/proxy.mjs" "$Dest/"
else
  for f in opencodeclaude.ps1 proxy.mjs; do
    echo "Downloading $f ..."
    curl -fsSL "$RepoUrl/$f" -o "$Dest/$f"
  done
fi

mkdir -p "$BinDir"
cat > "$BinDir/opencodeclaude" <<EOF
#!/usr/bin/env sh
exec pwsh -NoProfile -File "$Dest/opencodeclaude.ps1" "\$@"
EOF
chmod +x "$BinDir/opencodeclaude"

echo ''
echo 'opencodeclaude installed.'
echo "  Files: $Dest"
echo "  Shim:  $BinDir/opencodeclaude"
echo ''
echo "Add $BinDir to PATH if missing, then run: opencodeclaude"
echo 'First run asks for your OpenCode API key (https://opencode.ai/auth).'
