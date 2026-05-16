@echo off
set "SRC=C:\Users\Ulf\relayplane-fork2\dist"
set "DST=C:\Users\Ulf\AppData\Roaming\npm\node_modules\@relayplane\proxy\dist"

echo Source: %SRC%
echo Dest:   %DST%
echo.

echo --- Checking source ---
if exist "%SRC%\standalone-proxy.js" (echo Source file exists) else (echo SOURCE FILE MISSING)

echo --- Checking dest dir ---
if exist "%DST%" (echo Dest dir exists) else (echo DEST DIR MISSING)

echo --- Checking dest is writable ---
echo test > "%DST%\write-test.tmp" 2>&1
if %ERRORLEVEL% neq 0 (
    echo DEST NOT WRITABLE
) else (
    del "%DST%\write-test.tmp"
    echo Dest is writable
)

echo --- Trying xcopy ---
xcopy /E /Y "%SRC%\*" "%DST%\"
echo ERRORLEVEL: %ERRORLEVEL%

echo.
echo --- Trying robocopy ---
robocopy "%SRC%" "%DST%" /E /NFL /NDL /NJH /NJS
echo ERRORLEVEL: %ERRORLEVEL%

pause
