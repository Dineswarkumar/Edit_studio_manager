@echo off
echo Starting Frame Studio...
cd /d "%~dp0"
python server.py --lan --open %*
pause
