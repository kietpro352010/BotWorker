@echo off
title KingMC - Worker Slot [AFK Bot Host]
color 0A
cd /d D:\worker
echo ========================================================
echo   KINGMC WORKER FLEET - LOCAL HOST STARTING
echo ========================================================
node --max-old-space-size=384 src/index.js 2>&1 | powershell -Command "$input | Tee-Object -FilePath 'D:\worker\worker.log'"
pause
