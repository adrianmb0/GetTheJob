#!/bin/bash
# GetTheJob — double-click to launch dashboard
# Drag this file to your Dock for one-click access.

# Ensure PATH includes common install locations (Homebrew, nvm, etc.)
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null

# Resolve the directory this script lives in
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Node.js not found. Install from https://nodejs.org"
  echo "Press any key to close..."
  read -n1
  exit 1
fi

# Kill any existing server on the same port
lsof -ti:3737 | xargs kill 2>/dev/null || true
sleep 0.5

# Start the server (morning batch auto-launches inside server.mjs)
echo "Starting GetTheJob..."
AUTOSTART_BATCH=1 node server.mjs &
SERVER_PID=$!
sleep 1

# Open the dashboard in the default browser
open "http://localhost:3737"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GetTheJob → http://localhost:3737"
echo "  Morning batch auto-starting in background..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  You can minimize this window."
echo "  Press Ctrl-C to stop the server."
echo ""

# Keep alive — Ctrl-C stops the server
wait $SERVER_PID
