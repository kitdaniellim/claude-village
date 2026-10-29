# RTS Agents — desktop shell

An Electron window around the village dashboard. It starts the bun server
(`:4444`) and the Vite client (`:4445`) for you if they are not already running,
lives in the system tray, can launch at login, and exposes `window.rts`
(see `client/src/types/desktop.d.ts`) so the dashboard can open real
Claude Code terminals (node-pty) from inside the app.

`desktop/` is a standalone **npm** package — it is deliberately *not* part of
the bun workspaces (Electron needs its binary download and node-pty is a native
module; bun blocks lifecycle scripts by default).

## Install / run

```sh
# from the repo root
bun run desktop:install   # = cd desktop && npm install  (downloads Electron, ~250 MB once)
bun run desktop           # = cd desktop && npm run dev  (tsc build, then electron . --dev)
bun run desktop:smoke     # headless self-test, prints "SMOKE OK <claude version>"
```

Inside `desktop/`:

| script        | what it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `npm run dev`   | build + `electron . --dev` → always uses the Vite dev server on `:4445` (HMR) |
| `npm start`     | build + `electron .` → loads the built `client/dist/index.html` from `file://` when it exists, otherwise falls back to the dev server. Run `bun run build` at the repo root first to (re)build the client. |
| `npm run smoke` | build + `electron . --smoke` — no window; resolves `claude`, runs `claude --version` inside a node-pty ConPTY under Electron, prints `SMOKE OK …` and exits 0 (or `SMOKE FAIL …` / exit 1) |
| `npm run build` | `tsc -p .` → `dist/main.js`, `dist/preload.js`                               |
| `npm run rebuild` | force `electron-rebuild -f -w node-pty` (normally not needed, see below) |

Flags: `--dev` (force the Vite dev server even if `client/dist` exists),
`--hidden` (start in the tray without showing the window), `--smoke`.

### What happens on launch

1. `GET http://localhost:4444/healthz`. If it fails, `bun.cmd run dev:server` is
   spawned from the repo root (resolved as `desktop/../`). The child process tree
   is killed when the app quits (`taskkill /T /F` on Windows). A server that was
   already running (e.g. from `bun start` in a terminal) is left alone.
2. In dev mode the same is done for the client on `:4445` (`bun run dev:client`),
   polling with back-off for up to 30 s behind a "starting village…" splash.
3. The window (1600×1000, min 1100×700) loads the dashboard. Closing the window
   hides it to the tray; **Quit** in the tray menu really quits.

### Settings

Persisted as JSON at `%APPDATA%\RTS Agents\settings.json`
(`app.getPath('userData')`), shape = `DesktopSettings`:

```json
{ "openAtLogin": false, "startMinimized": false, "sound": true }
```

Change them from the dashboard through `window.rts.setSettings(...)` or toggle
**Launch at login** in the tray menu.

### Launch at login (unpackaged app)

There is no installer. `openAtLogin` calls Electron's `app.setLoginItemSettings`
with `path: process.execPath` and `args: ["<abs path to desktop/>", "--hidden"?]`.
On Windows that writes a `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
entry equivalent to:

```
"…\desktop\node_modules\electron\dist\electron.exe" "G:\…\rts-agents\desktop" --hidden
```

i.e. the stock `electron.exe` launched with the app directory as its argument.
Consequences:

- Moving or renaming the repo breaks the entry — toggle the setting off/on (or
  just relaunch the app: it re-applies the entry on startup while `openAtLogin`
  is true).
- Deleting `desktop/node_modules` removes the binary the entry points at.
- `startMinimized: true` adds `--hidden`, so the app starts in the tray only.

## Troubleshooting

**`npm install` fails rebuilding node-pty / `GetCommitHash.bat is not recognized`** —
node-pty ≥ 1.1 ships N-API prebuilds (`node_modules/node-pty/prebuilds/win32-x64/`)
that load under Electron without any rebuild, so the postinstall
(`scripts/postinstall.js`) skips `electron-rebuild` whenever a prebuild for your
platform exists. If you force a from-source build (`npm run rebuild` or
`npm_config_build_from_source=true`), you need MSVC Build Tools + Python, and the
winpty gyp step is known to fail when the repo path contains spaces — clone to a
path without spaces for that case.

**`electron.exe` missing after install** — Electron ≥ 44 no longer downloads its
binary in a postinstall; our `scripts/postinstall.js` runs `install-electron`
for you. If it was interrupted, run `npm install` again (it is idempotent) or
`npx install-electron`.

**`bun` not found / "could not start the village"** — the shell spawns
`bun.cmd` (Windows) or `bun` from `PATH`. Install Bun and make sure the terminal
(or the login session, for launch-at-login) can see it; or start `bun start` in
a terminal yourself — the app detects running services and just connects.

**Ports busy** — `:4444` / `:4445` are hard-wired here (the server's `PORT` and
Vite's `strictPort`). If another process holds them, the health checks succeed
against the wrong thing or the spawn fails with `EADDRINUSE`; free the ports.

**Only one window** — a single-instance lock is held; launching again focuses
the existing window (or shows it from the tray).

**Blank window in `npm start`** — the built client is stale or absent. Run
`bun run build` at the repo root (`client/vite.config.ts` sets `base: './'` and
pins `VITE_SERVER_URL` to `localhost:4444` for builds, which `file://` needs).

**Terminals never open** — `window.rts.claudePath()` returns `null` when
neither `%USERPROFILE%\.local\bin\claude.exe` nor `where claude` finds the CLI.
Run `npm run smoke` to see the exact resolution result.
