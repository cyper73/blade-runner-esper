#!/bin/bash
# ESPER — Photo Analysis Unit · avvio locale
# Doppio clic da Finder, oppure: ./start.command
set -e
cd "$(dirname "$0")"
PORT=8777

if [ ! -x ./.venv/bin/python ]; then
  echo "Ambiente Python mancante. Creo .venv e installo le dipendenze…"
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet "numpy<2" pillow "torch==2.2.2" fastapi "uvicorn[standard]" python-multipart
fi

mkdir -p logs

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Server già attivo su http://127.0.0.1:$PORT"
else
  echo "Avvio ESPER su http://127.0.0.1:$PORT …"
  ( ./.venv/bin/python server.py > logs/server.log 2>&1 & )
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then break; fi
    sleep 0.6
  done
fi

open "http://127.0.0.1:$PORT"
echo "Pronto. Chiudi questa finestra pure: il server resta in background."
echo "Per fermarlo:  pkill -f 'python server.py'"
