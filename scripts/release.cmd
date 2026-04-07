@echo off
setlocal enabledelayedexpansion

:: RelayPlane Proxy Release Script
:: Deploys changes atomically: test → build → backup → stop → copy → start → validate
:: Run from an admin terminal.

set "FORK_DIR=C:\Users\Ulf\relayplane-fork2"
set "SERVICE_DIR=C:\Users\Ulf\AppData\Roaming\npm\node_modules\@relayplane\proxy"
set "CONFIG_FILE=C:\Users\Ulf\.relayplane\config.json"
set "BACKUP_DIR=C:\Users\Ulf\.relayplane\release-backups"
set "TASK_NAME=RelayPlane Proxy"
set "HEALTH_URL=http://localhost:4010/health"

echo ============================================
echo   RelayPlane Proxy Release
echo ============================================
echo.

:: Step 1: Run tests
echo [1/7] Running tests...
cd /d "%FORK_DIR%"
call npx vitest run __tests__/oauth-passthrough.test.ts __tests__/ollama-native.test.ts __tests__/openrouter-native.test.ts __tests__/complexity-basic.test.ts __tests__/model-masking.test.ts __tests__/openai-to-anthropic-stream.test.ts --reporter=dot 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo *** RELEASE ABORTED: Tests failed ***
    exit /b 1
)
echo Tests passed.
echo.

:: Step 2: Build
echo [2/7] Building TypeScript...
call npx tsc 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo *** RELEASE ABORTED: Build failed ***
    exit /b 1
)
echo Build succeeded.
echo.

:: Step 3: Create backup
echo [3/7] Creating backup...
for /f "tokens=1-3 delims=/ " %%a in ('date /t') do set "DATESTAMP=%%c%%a%%b"
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set "TIMESTAMP=%%a%%b"
set "BACKUP_NAME=%DATESTAMP%_%TIMESTAMP%"
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
if not exist "%BACKUP_DIR%\%BACKUP_NAME%" mkdir "%BACKUP_DIR%\%BACKUP_NAME%"
robocopy "%SERVICE_DIR%\dist" "%BACKUP_DIR%\%BACKUP_NAME%\dist" /E /NFL /NDL /NJH /NJS /NP >nul 2>&1
copy /Y "%CONFIG_FILE%" "%BACKUP_DIR%\%BACKUP_NAME%\config.json" >nul 2>&1
echo Backup saved to %BACKUP_DIR%\%BACKUP_NAME%
echo.

:: Step 4: Stop service (releases file locks)
echo [4/7] Stopping service...
schtasks /End /TN "%TASK_NAME%" >nul 2>&1
timeout /t 2 /nobreak >nul
:: Also kill any rogue process on the port
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":4010.*LISTENING"') do (
    echo   Killing rogue process PID %%p
    taskkill /PID %%p /F >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo Service stopped.
echo.

:: Step 5: Copy dist files
echo [5/7] Deploying compiled files...
robocopy "%FORK_DIR%\dist" "%SERVICE_DIR%\dist" /E /NFL /NDL /NJH /NJS /NP >nul 2>&1
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
    echo.
    echo RELEASE ABORTED: Failed to copy dist files, robocopy exit %RC%
    echo Restarting service with previous version...
    schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
    exit /b 1
)

:: Copy staged config if it exists
if exist "%FORK_DIR%\staged-config.json" (
    echo Deploying staged config...
    copy /Y "%FORK_DIR%\staged-config.json" "%CONFIG_FILE%" >nul 2>&1
)
echo Files deployed.
echo.

:: Step 6: Start service
echo [6/7] Starting service...
schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo *** WARNING: Failed to start service. Restoring backup... ***
    robocopy "%BACKUP_DIR%\%BACKUP_NAME%\dist" "%SERVICE_DIR%\dist" /E /NFL /NDL /NJH /NJS /NP >nul 2>&1
    copy /Y "%BACKUP_DIR%\%BACKUP_NAME%\config.json" "%CONFIG_FILE%" >nul 2>&1
    schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
    echo Backup restored.
    exit /b 1
)
echo Service started. Waiting for startup...
timeout /t 5 /nobreak >nul
echo.

:: Step 7: Health check
echo [7/7] Validating health...
curl -s "%HEALTH_URL%" > "%TEMP%\rp_health.json" 2>&1
if %ERRORLEVEL% neq 0 (
    echo *** HEALTH CHECK FAILED: Proxy not responding ***
    echo Rolling back...
    schtasks /End /TN "%TASK_NAME%" >nul 2>&1
    timeout /t 2 /nobreak >nul
    robocopy "%BACKUP_DIR%\%BACKUP_NAME%\dist" "%SERVICE_DIR%\dist" /E /NFL /NDL /NJH /NJS /NP >nul 2>&1
    copy /Y "%BACKUP_DIR%\%BACKUP_NAME%\config.json" "%CONFIG_FILE%" >nul 2>&1
    schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
    echo Rolled back to previous version.
    exit /b 1
)

:: Verify health response contains "ok"
findstr /C:"\"status\":\"ok\"" "%TEMP%\rp_health.json" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo *** HEALTH CHECK FAILED: Proxy not healthy ***
    type "%TEMP%\rp_health.json"
    echo.
    echo Rolling back...
    schtasks /End /TN "%TASK_NAME%" >nul 2>&1
    timeout /t 2 /nobreak >nul
    robocopy "%BACKUP_DIR%\%BACKUP_NAME%\dist" "%SERVICE_DIR%\dist" /E /NFL /NDL /NJH /NJS /NP >nul 2>&1
    copy /Y "%BACKUP_DIR%\%BACKUP_NAME%\config.json" "%CONFIG_FILE%" >nul 2>&1
    schtasks /Run /TN "%TASK_NAME%" >nul 2>&1
    echo Rolled back to previous version.
    exit /b 1
)

echo.
echo ============================================
echo   RELEASE SUCCESSFUL
echo ============================================
type "%TEMP%\rp_health.json"
echo.
echo.
echo Backup at: %BACKUP_DIR%\%BACKUP_NAME%
echo To roll back manually: scripts\rollback.cmd %BACKUP_NAME%
echo.
pause
