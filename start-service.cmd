@echo off
:: RelayPlane service starter for Task Scheduler
:: Redirects output to log file since there's no console
set LOGFILE=%USERPROFILE%\.relayplane\service.log
"C:\Program Files\nodejs\node.exe" "%USERPROFILE%\AppData\Roaming\npm\node_modules\@relayplane\proxy\dist\cli.js" --port 4010 >> "%LOGFILE%" 2>&1
