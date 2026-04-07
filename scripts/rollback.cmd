@echo off
setlocal

:: RelayPlane Proxy Rollback Script
:: Usage: rollback.cmd <backup-name>
:: Run from an admin terminal.

set "SERVICE_DIR=C:\Users\Ulf\AppData\Roaming\npm\node_modules\@relayplane\proxy"
set "CONFIG_FILE=C:\Users\Ulf\.relayplane\config.json"
set "BACKUP_DIR=C:\Users\Ulf\.relayplane\release-backups"
set "TASK_NAME=RelayPlane Proxy"

if "%~1"=="" (
    echo Usage: rollback.cmd ^<backup-name^>
    echo.
    echo Available backups:
    dir /B "%BACKUP_DIR%" 2>nul
    exit /b 1
)

set "BACKUP=%BACKUP_DIR%\%~1"
if not exist "%BACKUP%" (
    echo Backup not found: %BACKUP%
    echo.
    echo Available backups:
    dir /B "%BACKUP_DIR%" 2>nul
    exit /b 1
)

echo Rolling back to: %~1
echo.

schtasks /End /TN "%TASK_NAME%" >nul 2>&1
timeout /t 3 /nobreak >nul

robocopy "%BACKUP%\dist" "%SERVICE_DIR%\dist" /E /NFL /NDL /NJH /NJS /NP >nul 2>&1
if exist "%BACKUP%\config.json" (
    copy /Y "%BACKUP%\config.json" "%CONFIG_FILE%" >nul 2>&1
)

schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
timeout /t 5 /nobreak >nul

curl -s http://localhost:4010/health
echo.
echo.
echo Rollback complete.
pause
