@echo off
cd /d "%~dp0"
echo Starting KM DocH. The first start downloads and builds everything and can take 5-10 minutes...
docker compose up --build -d
if errorlevel 1 (
  echo.
  echo Could not start. Make sure Docker Desktop is installed and running, then try again.
  pause
  exit /b 1
)
echo Waiting for the server to be ready...
:wait
timeout /t 3 /nobreak >nul
curl -s -o nul -f http://localhost:3000/healthz || goto wait
start "" http://localhost:3000/dev
echo.
echo KM DocH is running: http://localhost:3000/dev
echo To stop it, double-click stop-windows.bat
pause
