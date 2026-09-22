@echo off
title Jade-Disc-of-Creation
cd /d "%~dp0"

echo [Jade-Disc] starting...

REM Install server deps if missing
if not exist "server\node_modules" (
  echo [Jade-Disc] installing server deps...
  pushd server
  call npm install --no-fund --no-audit
  popd
)

REM Install client deps if missing
if not exist "client\node_modules" (
  echo [Jade-Disc] installing client deps...
  pushd client
  call npm install --no-fund --no-audit
  popd
)

REM Always rebuild frontend to keep dist fresh
echo [Jade-Disc] building frontend...
pushd client
call npm run build
popd
if errorlevel 1 (
  echo [Jade-Disc] build failed, abort.
  pause
  exit /b 1
)

REM Kill any old backend on port 8346
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8346" ^| findstr "LISTENING"') do (
  echo [Jade-Disc] killing old backend pid %%a
  taskkill /PID %%a /F >nul 2>&1
)

echo [Jade-Disc] backend: http://127.0.0.1:8346
start "" http://127.0.0.1:8346
pushd server
node index.js
popd
