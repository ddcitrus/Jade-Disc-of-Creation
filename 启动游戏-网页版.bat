@echo off
REM NOTE (please keep this file pure ASCII):
REM   cmd.exe decodes a .bat using the console code page (GBK on zh-CN). Multi-byte
REM   UTF-8 text inside a .bat gets mis-decoded and can swallow the first characters
REM   of the next token (a Chinese REM line once turned `findstr` into `dstr`).
REM   So: NO non-ASCII characters in this file. Chinese messages are printed by node
REM   (see server/index.js), which is why we switch the console to UTF-8 below.
chcp 65001 >nul
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

REM ---------------------------------------------------------------
REM Kill any old backend on port 8346
REM 2026-09-24: previously this used `taskkill ... >nul 2>&1`, which swallowed the
REM result, so a failed kill was invisible. Now the output is shown and we re-check
REM the port afterwards.
REM ---------------------------------------------------------------
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8346" ^| findstr "LISTENING"') do (
  echo [Jade-Disc] killing old backend pid %%a
  taskkill /PID %%a /T /F
)
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":8346" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [Jade-Disc] WARNING: port 8346 is STILL occupied - the new backend will fail to start.
  echo [Jade-Disc]          open Task Manager and end this pid manually:
  netstat -ano | findstr ":8346" | findstr "LISTENING"
)

echo [Jade-Disc] backend: http://127.0.0.1:8346
start "" http://127.0.0.1:8346
pushd server
node index.js
set "RC=%errorlevel%"
popd

REM ---------------------------------------------------------------
REM 2026-09-24: this used to be the last line of the script. As soon as node exited
REM the script was done and the console window closed itself, so a start-up failure
REM (port already in use, etc.) flashed by in under a second - the user just saw
REM "I opened it and the backend closed itself". Now a non-zero exit keeps the
REM window open with the reason still on screen.
REM ---------------------------------------------------------------
if not "%RC%"=="0" (
  echo.
  echo [Jade-Disc] backend exited with code %RC%. Reason is printed above.
  echo [Jade-Disc] press any key to close this window...
  pause >nul
)
