@echo off
rem Double-click launcher: starts the RTS Agents desktop app (server + client + Electron).
cd /d "%~dp0"
call bun run desktop
