@echo off
rem ESPER — launcher for Windows
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo No virtualenv found at .venv
  echo Create it with:
  echo    python -m venv .venv
  echo    .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)

start "ESPER server" /min ".venv\Scripts\python.exe" server.py
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8777"
