#!/bin/bash
# start.sh — Launch claude-code-proxy
# Usage: ./start.sh          (foreground)
#        ./start.sh --bg     (background, logs to /tmp/claude-proxy.log)

DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:$PATH"

# Kill existing proxy if running
EXISTING_PID=$(pgrep -f "node.*claude-code-proxy/server.mjs")
if [ -n "$EXISTING_PID" ]; then
  echo "Stopping existing proxy (PID $EXISTING_PID)..."
  kill "$EXISTING_PID" 2>/dev/null
  sleep 2
fi

if [ "$1" = "--bg" ]; then
  nohup /opt/homebrew/bin/node "$DIR/server.mjs" >> /tmp/claude-proxy.log 2>&1 &
  echo "Proxy started in background (PID $!)"
  echo "Logs: /tmp/claude-proxy.log"
else
  exec /opt/homebrew/bin/node "$DIR/server.mjs"
fi
