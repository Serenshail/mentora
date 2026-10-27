@echo off
cd /d D:\zcode\agent\mentora
set NODE_ENV=production
start /b "" "D:\zcode\agent\mentora\node_modules\.bin\next" start >> D:\zcode\agent\mentora\scripts\keep-alive.log 2>&1
