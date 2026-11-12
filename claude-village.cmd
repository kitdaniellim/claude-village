@echo off
rem Double-click launcher: starts the claude-village desktop app (server + client + Electron).
rem Start menu / Desktop shortcut: powershell -ExecutionPolicy Bypass -File scripts\install-windows-shortcut.ps1
cd /d "%~dp0"
if not exist node_modules call bun install
if not exist desktop\node_modules\electron call bun run desktop:install
call bun run desktop
