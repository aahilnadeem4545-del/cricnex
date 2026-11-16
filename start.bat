@echo off
cd /d "%~dp0"
echo === Stopping any old server on port 4000 ===
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4000 ^| findstr LISTENING') do taskkill /PID %%a /F 2>nul
timeout /t 1 /nobreak >nul
echo === Building ===
call npm run build
if errorlevel 1 ( echo BUILD FAILED & pause & exit /b 1 )
echo === Starting CRICNEX ===
npm start
pause