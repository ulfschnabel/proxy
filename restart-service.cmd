@echo off
echo Stopping RelayPlane Proxy...
schtasks /End /TN "RelayPlane Proxy"
timeout /t 3 /nobreak >nul
echo Starting RelayPlane Proxy...
schtasks /Run /TN "RelayPlane Proxy" >nul 2>&1 || node "%~dp0dist\cli.js" ensure-running --port 4010 --host 127.0.0.1
timeout /t 5 /nobreak >nul
echo Checking health...
curl -s http://localhost:4010/health
echo.
echo Done.
pause
