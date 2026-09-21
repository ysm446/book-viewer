@echo off
setlocal
cd /d "%~dp0"

REM Clear ELECTRON_RUN_AS_NODE inherited from the VSCode integrated terminal.
REM If left set, Electron starts in Node mode and "app" becomes undefined.
set "ELECTRON_RUN_AS_NODE="

echo === Book Viewer ===

REM --- Node dependencies (first run only) ---
if not exist "node_modules" (
  echo [setup] Running npm install ...
  call npm install || goto :error
)

REM --- Python venv (first run only) ---
if not exist "backend\.venv" (
  echo [setup] Creating Python venv ...
  py -3 -m venv backend\.venv || goto :error
  echo [setup] Installing backend dependencies ...
  call backend\.venv\Scripts\python.exe -m pip install --upgrade pip || goto :error
  call backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt || goto :error
)

echo [start] Launching app (npm run dev) ...
call npm run dev
goto :eof

:error
echo.
echo [ERROR] Setup failed. See the output above.
pause
exit /b 1
