#!/bin/bash
# GetTheJob — double-click to launch the dashboard (Terminal-native alternative
# to GetTheJob.app). Drag to your Dock for one-click access.

# --- Find node/npm (Homebrew, nvm, user bins) ---
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
[ -f "$HOME/.zprofile" ]     && source "$HOME/.zprofile"     2>/dev/null
[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null
[ -s "$HOME/.nvm/nvm.sh" ]   && source "$HOME/.nvm/nvm.sh"   2>/dev/null

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

PORT=3737
PING_URL="http://localhost:$PORT/api/ping"
APP_URL="http://localhost:$PORT"
WELCOME_URL="file://$SCRIPT_DIR/web/welcome.html"

# --- Node.js present AND new enough (major >= 18)? ---
node_major() {
  local v
  v="$(node -v 2>/dev/null)"; v="${v#v}"; v="${v%%.*}"
  case "$v" in ''|*[!0-9]*) return 1 ;; *) printf '%s' "$v" ;; esac
}
NODE_OK=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  MAJOR="$(node_major)" && [ -n "$MAJOR" ] && [ "$MAJOR" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  open "$WELCOME_URL?state=node" 2>/dev/null
  open "https://nodejs.org/en/download" 2>/dev/null
  echo "GetTheJob needs Node.js 18 or newer. A page just opened with the download —"
  echo "install the LTS version, then run this again."
  echo "Press any key to close..."; read -n1
  exit 1
fi

# --- Already running? Focus the browser. ---
if curl -fsS -m 1 "$PING_URL" >/dev/null 2>&1; then
  echo "GetTheJob is already running -> $APP_URL"
  open "$APP_URL"
  exit 0
fi

lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null || true
sleep 0.5

# --- First run (no node_modules): install here (visible). The welcome page in the
# browser polls and auto-forwards to onboarding when the server comes up. ---
SHOW_WELCOME=0
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  SHOW_WELCOME=1
  open "$WELCOME_URL?state=setup" 2>/dev/null
  echo ""
  echo "=== GetTheJob first-time setup ==="
  echo "Installing dependencies (about a minute)..."
  echo ""
  if ! npm install; then
    echo ""
    echo "npm install failed — see the error above. Fix it, then run this again."
    echo "Press any key to close..."; read -n1
    exit 1
  fi
fi

echo ""
echo "Starting GetTheJob..."
AUTOSTART_BATCH=1 node server.mjs &
SERVER_PID=$!

# Open the browser once the server actually answers (the welcome page also
# auto-forwards on first run, so only open here when we didn't show it).
for i in $(seq 1 60); do
  if curl -fsS -m 1 "$PING_URL" >/dev/null 2>&1; then
    [ "$SHOW_WELCOME" -eq 1 ] || open "$APP_URL"
    break
  fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done

echo ""
echo "GetTheJob -> $APP_URL    (leave this window open; Ctrl-C to stop)"
echo ""
wait "$SERVER_PID"
