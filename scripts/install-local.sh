#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${CODE_INTEL_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${CODE_INTEL_HOME:-$HOME/.code-intelligence}"

mkdir -p "$BIN_DIR" "$DATA_DIR"

cd "$ROOT_DIR"
npm install
npm run build

cat > "$BIN_DIR/code-intel" <<EOF
#!/usr/bin/env bash
export CODE_INTEL_HOME="\${CODE_INTEL_HOME:-$DATA_DIR}"
exec node "$ROOT_DIR/packages/cli/dist/index.js" "\$@"
EOF

cat > "$BIN_DIR/code-intel-mcp" <<EOF
#!/usr/bin/env bash
export CODE_INTEL_HOME="\${CODE_INTEL_HOME:-$DATA_DIR}"
exec node "$ROOT_DIR/packages/mcp/dist/server.js" "\$@"
EOF

chmod +x "$BIN_DIR/code-intel" "$BIN_DIR/code-intel-mcp"

echo "Code Intelligence installed locally."
echo "CLI: $BIN_DIR/code-intel"
echo "MCP: $BIN_DIR/code-intel-mcp"
echo "Data: $DATA_DIR"
echo
echo "Add this to PATH if needed:"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
echo
echo "Codex MCP example:"
echo "  command = \"$BIN_DIR/code-intel-mcp\""
