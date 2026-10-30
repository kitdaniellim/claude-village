#!/usr/bin/env bash
# Creates ~/Applications/RTS Agents.app — a tiny AppleScript applet around scripts/launch-desktop.sh — so the
# village opens from Spotlight, Launchpad or the Dock. Re-run after moving the repo.
set -euo pipefail
[ "$(uname)" = Darwin ] || { echo "macOS only (Windows: scripts/install-windows-shortcut.ps1)" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HOME/Applications/RTS Agents.app"

rm -rf "$APP"
chmod +x "$ROOT/scripts/launch-desktop.sh"
# An AppleScript applet, not a bare shell-script bundle: LaunchServices runs it reliably and macOS
# can ask once for access to the folder holding the repo (e.g. ~/Documents) instead of failing silently.
LAUNCH="$ROOT/scripts/launch-desktop.sh"
osacompile -o "$APP" -e "do shell script quoted form of \"$LAUNCH\" & \" >/dev/null 2>&1\""
/usr/libexec/PlistBuddy -c "Set :CFBundleName RTS Agents" "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string dev.rts-agents.launcher" "$APP/Contents/Info.plist" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier dev.rts-agents.launcher" "$APP/Contents/Info.plist"

# Borrow Electron's icon until the app has its own .icns.
ICNS="$ROOT/desktop/node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"
[ -f "$ICNS" ] && cp "$ICNS" "$APP/Contents/Resources/applet.icns"

# The edits above broke osacompile's ad-hoc signature — re-sign so Gatekeeper still opens it.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "Installed: $APP"
echo "Open it from Spotlight (⌘Space → RTS Agents) or drag it to the Dock."
