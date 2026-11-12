#!/usr/bin/env bash
# Starts the claude-village desktop app (macOS / Linux) detached from the terminal:
# installs missing deps on first run, rebuilds the Electron shell, then hands off to Electron
# (which boots the server + client itself). Output goes to ~/.rts-agents/desktop.log.
set -euo pipefail

# Finder / Dock launches get a bare PATH.
export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.rts-agents"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/desktop.log"

fail() {
  echo "error: $1" >&2
  [ "$(uname)" = Darwin ] && osascript -e "display alert \"claude-village\" message \"$1\"" >/dev/null 2>&1 || true
  exit 1
}

command -v bun >/dev/null 2>&1 || fail "bun not found — install it: curl -fsSL https://bun.sh/install | bash"
command -v npm >/dev/null 2>&1 || fail "npm not found — install Node.js (https://nodejs.org)"

cd "$ROOT"
[ -d node_modules ] || bun install >>"$LOG" 2>&1 || fail "bun install failed — see $LOG"
[ -d desktop/node_modules/electron ] || (cd desktop && npm install) >>"$LOG" 2>&1 || fail "desktop npm install failed — see $LOG"
(cd desktop && npm run build) >>"$LOG" 2>&1 || fail "desktop build failed — see $LOG"

echo "--- $(date) launch $*" >>"$LOG"
# --dev = live Vite client (HMR) like `bun run desktop`; a second launch just refocuses the window.
if [ "$(uname)" = Darwin ]; then
  # Through LaunchServices, not a nohup'd binary: macOS then treats it as a normal app
  # (activation + keyboard focus, Dock icon, Documents access), detached from this shell.
  BUNDLE="$ROOT/desktop/node_modules/electron/dist/Electron.app"
  [ -d "$BUNDLE" ] || fail "Electron missing — run: bun run desktop:install"
  open -a "$BUNDLE" --stdout "$LOG" --stderr "$LOG" --args "$ROOT/desktop" --dev "$@"
else
  ELECTRON="$ROOT/desktop/node_modules/electron/dist/electron"
  [ -x "$ELECTRON" ] || fail "Electron missing — run: bun run desktop:install"
  nohup "$ELECTRON" "$ROOT/desktop" --dev "$@" >>"$LOG" 2>&1 &
  disown
fi
