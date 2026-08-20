@echo off
REM E4/T31 (ADR-022) - Kimlik broker'i: konteynerdeki claude CLI'lar HOST aboneligini
REM bu surec uzerinden kullanir; ham kimlik konteynere ASLA girmez (INV-2).
REM Ortam (isteğe bağlı): ACOS_BROKER_SECRET (>=16 karakter, agent-worker ile AYNI),
REM   CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token` ciktisi; yoksa %USERPROFILE%\.claude\.credentials.json okunur),
REM   IDENTITY_BROKER_PORT (3779), BROKER_MAX_LIVE_SESSIONS (12), BROKER_MAX_LIVE_SESSIONS_PER_COMPANY (4)
cd /d %~dp0..
if "%ACOS_BROKER_SECRET%"=="" set ACOS_BROKER_SECRET=dev-broker-secret-change-me-0123
call pnpm --filter @acos/identity-broker build
node services\identity-broker\dist\main.js
pause
