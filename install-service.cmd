@echo off
echo Installing RelayPlane Proxy as Windows scheduled task (watchdog)...
node "%~dp0dist\cli.js" service install
echo.
echo Done. The proxy will start automatically at login and restart if it crashes.
pause
