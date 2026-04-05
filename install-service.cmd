@echo off
schtasks /Create /TN "RelayPlane Proxy" /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\Users\Ulf\AppData\Roaming\npm\node_modules\@relayplane\proxy\dist\cli.js\" --port 4010" /SC ONLOGON /RU Ulf /RP * /RL LIMITED /F
schtasks /Run /TN "RelayPlane Proxy"
echo Waiting 5 seconds...
timeout /t 5 /nobreak >nul
curl -s http://localhost:4010/health
