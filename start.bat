@echo off
title Channel Changer
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this computer.
  echo  Download the LTS version from https://nodejs.org , install it, then double-click start.bat again.
  echo.
  pause
  exit /b 1
)
echo  Starting Channel Changer. The big screen opens in your browser in a moment.
echo  Keep this window open during the show. Close it to stop.
echo.
node server.js
pause
