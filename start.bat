@echo off
echo Starting Midwest 3on3 Data Explorer...
echo.

echo [1/2] Starting API server on port 3001...
start "SE API Server" cmd /k "cd /d "%~dp0server" && node index.js"

echo Waiting for server to start...
timeout /t 3 /nobreak > nul

echo [2/2] Starting React frontend on port 3000...
start "SE Frontend" cmd /k "cd /d "%~dp0client" && npm start"

echo.
echo ========================================
echo  Midwest 3on3 Data Explorer
echo ========================================
echo  Frontend: http://localhost:3000
echo  API:      http://localhost:3001
echo ========================================
echo.
echo Browser will open automatically.
timeout /t 5 /nobreak > nul
start http://localhost:3000
