# ⚔️ RTS Agents

A real-time, gamified command centre for your local [Claude Code](https://claude.com/claude-code) CLI sessions. Every running session becomes a pixel-art hero in a fantasy world: heroes rest at the **Tavern** in the middle and walk out along winding roads to the **city, dungeon or lair of the project they're working in**, where they hammer, read scrolls, spar or brew potions depending on the tool in use — all live, by tailing the session logs Claude Code already writes to `~/.claude*`. Select a hero and the **desktop app** opens its real Claude Code terminal next to the map. Inspired by [Agent Quest](https://github.com/FulAppiOS/Agent-Quest).

## Requirements

- **Bun ≥ 1.1** — [bun.sh](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- **Claude Code** installed and used at least once (so `~/.claude/projects/` exists)
- Windows (native, tested — run Bun as `bun.cmd` from Git Bash), macOS or Linux.
- For the desktop app: Node ≥ 20 + npm (Electron and node-pty are installed with npm, see below).

## Quick start

```sh
git clone <this-repo> rts-agents && cd rts-agents
bun install
bun start
```

Then open **http://localhost:4445**. The server listens on **http://localhost:4444**.

Start a Claude Code session in any terminal and watch a hero walk out of the tavern.

## The world

The **Tavern** sits in the centre — heroes that are idle, finished (waiting for you) or working from the bare coding root gather there. Everything around it is a **project**, resolved from each session's `cwd` by `client/src/world/registry.ts`:

| Place | Kind | Buildings (one per repo) |
| --- | --- | --- |
| 🏰 **SIF** | walled stone city | FlashWorks · External API · Photographer Tool · Old Portal · Event Management · Check-in App · Individual Photos |
| 🏘️ **HABITS** | timber market town | Internal Portal · Collegiate · Pixel Perfect · HR Hub (Lovable sessions have no local cwd, so they're placed by title keywords) |
| 🕳️ **Momma Mia** | dungeon | Web · Mobile · Supabase · Monorepo (doors in the cave) |
| 🐉 **Simone** | dragon lair | Outreach Studio · Newsance — a hero working here wards off the dragon |
| 🗼 **Portfolio**, 🏡 **The Village** (this repo) | wild landmarks | one each |
| ✨ anything new | wild landmark | auto-discovered the first time a session runs in an unknown folder ("Discovered!"), remembered in `localStorage` |

Edit `PLACES` in the registry to add a city or rename a building.

## Tool → action

A working hero walks to its repo's building and performs an action for the tool category:

| Category | Tools | Action |
| --- | --- | --- |
| 📚 library | `Read` `Glob` `LS` `Grep` | reads a scroll |
| 🔨 forge | `Edit` `Write` `MultiEdit` | hammers, with sparks |
| ⚔️ arena | `Bash` `PowerShell` `Execute` | sword drills |
| 🏰 castle | `Task` `Agent` `Workflow` | raises a banner |
| 🗼 watchtower | `TodoRead` `TodoWrite` plan mode | spyglass |
| ⛪ chapel | `WebSearch` `WebFetch` | kneels, glowing |
| ⚗️ alchemist | anything else (MCP tools, …) | stirs a cauldron |

Markers: `!` on error · `z z z` idle · sparkle when a turn finishes · ring on the selected hero. The party card shows the session's `/rename` name first, then its id and place, then a flavour line ("Hammering code…").

## Terminal drawer, sound, shortcuts

- **Click a hero or party card** → the right-hand drawer opens with that session. In the desktop app it is a real `claude --resume <id>` terminal (xterm.js + node-pty) in the session's folder, with **New session here** and **Shell** tabs; in a browser tab it shows the commands to copy instead.
- **Click a city or building** → "Start a quest" chooser for that project's repos.
- **Sound cues** (8-bit, synthesised): a fanfare when a session finishes a turn and needs you, a chime for the selected one, a buzz on errors, a blip for new sessions. 🔔 in the top bar mutes.
- Shortcuts: `` Ctrl+` `` toggle drawer · `M` mute · `Esc` close · `/` filter the party. Wheel zooms the map, drag pans, double-click a hero centres on it.

## Configuration

| Variable | Where | Default | Effect |
| --- | --- | --- | --- |
| `PORT` | `server/.env` | `4444` | HTTP + WebSocket server port |
| `CLIENT_URL` | `server/.env` | `http://localhost:4445` | Origin allowed by CORS |
| `RTS_LAN` | env | _(unset)_ | `1` binds `0.0.0.0` on both server & client and prints LAN URLs, so you can watch the village from another device |
| `VITE_SERVER_URL` | `client/.env` | `http://<hostname>:4444` | Point the dashboard at a non-default server |

Copy `server/.env.example` → `server/.env` (and the client one) to customise.

## Map editor

Click the ⚒ **editor** button in the top bar to enter editor mode: drag whole places (cities, the dungeon, the lair, landmarks) around the tile grid; roads re-route themselves. The layout persists in `localStorage` (`rts-agents.layout.v2`); **Reset layout** restores the defaults.

## Troubleshooting

**`bun: command not found`** — install Bun (`curl -fsSL https://bun.sh/install | bash`), then restart your shell. On Windows without WSL2: `npm install -g bun` also works.

**`port 4444 (or 4445) already in use`** — something else is bound there. Either stop it, or set `PORT` in `server/.env` (and `VITE_SERVER_URL` in `client/.env` to match). The client port lives in `client/vite.config.ts` (`strictPort` is on, so Vite fails fast instead of silently shifting ports).

**Empty village / "No ~/.claude installation detected"** — the server found no `~/.claude*` directory containing a `projects/` folder. Install Claude Code and run it once. If your install lives somewhere exotic, symlink it to `~/.claude`.

**Village is quiet (no heroes)** — only sessions with log activity in the last 30 minutes appear, and heroes retire from the village after 30 minutes of silence. Start (or type into) a Claude Code session and it will appear within a couple of seconds.

**"Server offline — retrying…" banner** — the dashboard lost its WebSocket. It reconnects automatically with exponential back-off (max 30s); check that `bun run dev:server` is still alive.

## Desktop app

An Electron shell (tray icon, **Launch on startup** toggle in ⚙ Settings, embedded Claude Code terminals via
node-pty) lives in [`desktop/`](./desktop/README.md). It is a separate npm
package, not a bun workspace:

```sh
bun run desktop:install   # once — downloads Electron
bun run desktop           # starts the server/client if needed, opens the window
bun run desktop:smoke     # headless self-test: SMOKE OK <claude version>
```

## Development

```sh
bun run dev:server   # server only (bun --watch)
bun run dev:client   # client only (vite)
bun run typecheck    # strict tsc over both workspaces
```

The wire protocol and module contracts are documented in [`PROTOCOL.md`](./PROTOCOL.md).
A global launcher lives at `bin/rts-agents` — symlink it onto your `PATH`:

```sh
ln -s "$(pwd)/bin/rts-agents" /usr/local/bin/rts-agents
```
