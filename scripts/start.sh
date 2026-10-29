#!/usr/bin/env bash
# Starts the RTS Agents server (port 4444) and client (port 4445) together.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found. Install it first:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  bun install
fi

exec bun start
