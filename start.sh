#!/usr/bin/env bash
# ESPER — launcher for macOS and Linux
# Double-click on macOS, or:  ./start.sh
set -euo pipefail
cd "$(dirname "$0")"

PY="./.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "No virtualenv found at .venv"
  echo "Create it with:"
  echo "  python3 -m venv .venv"
  echo "  ./.venv/bin/pip install -r requirements.txt"
  exit 1
fi

# stop a previous instance, then start a fresh one
pkill -f "server.py" 2>/dev/null || true
sleep 0.6
nohup "$PY" server.py >/tmp/esper-server.log 2>&1 &
sleep 1.6

URL="http://127.0.0.1:8777"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$URL"
else
  echo "Open $URL in your browser."
fi

echo "ESPER running — log: /tmp/esper-server.log"
