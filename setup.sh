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
echo "2. Add the live hooks to .claude/settings.json in your project:"
echo "   PostToolUse: checks every file Claude edits, flags violations in real time"
echo "   Stop:        prints a session summary when Claude finishes a response"
echo ""
cat <<EOF
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $UPTOCODE_DIR/node_modules/.bin/ts-node --transpile-only $UPTOCODE_DIR/session-start-hook.ts"
          }
        ]
      }
    ],
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
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $UPTOCODE_DIR/node_modules/.bin/ts-node --transpile-only $UPTOCODE_DIR/report-hook.ts"
          }
        ]
      }
    ]
  }
}
EOF

echo ""
echo "3. (Optional) Add the PR inspection workflow to your project:"
echo "   Copy ci/example-workflow.yml to .github/workflows/uptocode.yml"
echo "   This posts a Building Inspection Report on every pull request."
echo ""

echo "4. Add .uptocode/ to your .gitignore (session logs, not for committing):"
echo ""
echo "   echo '.uptocode/' >> .gitignore"
echo ""

echo "Once set up, start with:"
echo "   → 'Interview me to build my spec'  (create your spec through conversation)"
echo "   → 'Run generate-spec for this project'  (if you already have code)"
echo ""
echo "Set ANTHROPIC_API_KEY in your environment to use generate-spec."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
