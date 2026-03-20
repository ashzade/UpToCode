#!/bin/bash
# UpToCode setup — run once after cloning the repo.
# Installs dependencies and prints the config snippets to add to your project.

set -e

UPTOCODE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dependencies..."
cd "$UPTOCODE_DIR" && npm install --silent

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  UpToCode is ready. Add these to your project:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "1. Create .mcp.json in your project root:"
echo ""
cat <<EOF
{
  "mcpServers": {
    "uptocode": {
      "command": "node",
      "args": [
        "$UPTOCODE_DIR/node_modules/.bin/ts-node",
        "--transpile-only",
        "$UPTOCODE_DIR/mcp-server.ts"
      ]
    }
  }
}
EOF

echo ""
echo "2. Add the live hook to .claude/settings.json in your project:"
echo "   (This makes Claude fix violations automatically as it codes)"
echo ""
cat <<EOF
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node $UPTOCODE_DIR/node_modules/.bin/ts-node --transpile-only $UPTOCODE_DIR/uptocode-hook.ts"
          }
        ]
      }
    ]
  }
}
EOF

echo ""
echo "3. Write requirements.md in your project, then run:"
echo "   → compile-spec   (parse requirements.md → manifest.json)"
echo "   → contract-diff  (check code against spec)"
echo "   → generate-tests (generate adversarial test cases)"
echo "   → security-audit (find unguarded writes)"
echo "   → scale-monitor  (query live DB health)"
echo ""
echo "Set ANTHROPIC_API_KEY in your environment to use generate-spec."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
