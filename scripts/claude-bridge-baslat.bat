@echo off
REM Claude CLI koprusu - ajanlar aboneligin uzerinden Claude kullanir
cd /d %~dp0..
node scripts\claude-cli-bridge.mjs
pause
