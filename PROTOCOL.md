# RTS Agents — Internal Protocol & Module Contracts

This document is the single source of truth for how the server and client talk,
and what each module is responsible for. The wire types live in
`server/src/types.ts` and `client/src/types/agent.ts` (kept identical by hand).

## Transport

- Server: `Bun.serve` on `PORT` (default **4444**). Native Bun WebSocket (no `ws` package).
- WebSocket endpoint: `GET /ws` (upgrade). REST: `GET /api/agents`, `GET /api/rewards`, `GET /api/rally`, `GET /healthz`.
- CORS: respond to REST with `Access-Control-Allow-Origin: <CLIENT_URL>` (default
  `http://localhost:4445`); when `RTS_LAN=1`, allow `*` instead so LAN devices work.
- Client dev server: Vite on **4445** (`strictPort`).
- LAN mode: `RTS_LAN=1` → both bind `0.0.0.0`; server prints reachable LAN URLs
  (walk `os.networkInterfaces()`, IPv4, non-internal) on startup.

## WebSocket messages (server → client only; client never sends)

1. On connect the server immediately sends `snapshot` (full agents + last 50
   events + `claudeDirs` + `serverTime`).
2. State changes broadcast `agents` (the **full** agent list — small, simple,
   self-healing), coalesced to at most one per `BROADCAST_THROTTLE_MS` (250 ms).
   Requirement: any log change is reflected client-side within 2 s.
3. Each new activity feed line broadcasts as an individual `event` message.
4. If the set of discovered `~/.claude*` dirs changes, broadcast `meta`.
5. On SIGINT/SIGTERM the server broadcasts `shutdown`, closes sockets, exits.
   The client shows an offline banner and keeps retrying (backoff: 1s, 2s, 4s …
   capped at 30s, with ±20% jitter).

## Claude Code session log format (verified against real logs 2026-06-11)

Sessions live at `<home>/.claude*/projects/<project-slug>/<session-uuid>.jsonl`.
One JSON object per line. Top-level `type` discriminator — observed values:

| `type`                  | Meaning / use                                                   |
| ----------------------- | --------------------------------------------------------------- |
| `assistant`             | API message. `message.content[]` blocks: `text`, `thinking`, `tool_use {id,name,input}`. Also `message.model`, `message.stop_reason`. |
| `user`                  | User prompt **or** tool results (`message.content[]` has `tool_result {tool_use_id, is_error?}`). `isMeta: true` lines are synthetic — skip for prompt detection. |
| `system`                | Hook/system notices — ignore.                                    |
| `ai-title`              | `{ aiTitle, sessionId }` → session title.                        |
| `custom-title` / `agent-name` | `{ customTitle }` / `{ agentName }` — written by `/rename`; both carry the same value → `customTitle` (shown in preference to `title`). |
| `last-prompt`           | `{ lastPrompt }` → title fallback.                               |
| `mode`, `file-history-snapshot`, `attachment`, `summary`, … | Ignore silently. Unknown types must never throw. |

Common envelope fields on `user`/`assistant` lines: `sessionId`, `timestamp`
(ISO 8601), `uuid`, `parentUuid`, `cwd`, `gitBranch`, `version`,
**`isSidechain`** (`true` = subagent traffic → skip for hero status, do count
toward `eventCount`).

### Status derivation (main chain only)

| Log evidence                                                | New status | Feed event |
| ----------------------------------------------------------- | ---------- | ---------- |
| `assistant` line containing `tool_use`                       | `running` (tool = block name, detail from input) | `tool_start` |
| `assistant` line with only `thinking`/`text`, stop_reason ∉ {end_turn, stop_sequence} | `thinking` | `thinking` (only on transition into thinking) |
| `assistant` line with `stop_reason` ∈ {`end_turn`, `stop_sequence`} | `done`    | `turn_done` |
| `user` line with `tool_result`, `is_error: true`             | `error`    | `tool_error` |
| `user` line with `tool_result`, no error                     | `thinking` (model is composing next step) | `tool_done` |
| `user` line that is a real prompt (no tool_result, not `isMeta`) | `thinking` | — |
| No events for `IDLE_AFTER_MS` (2 min) and status ∉ {done, error, idle, delegating} | `idle`    | `session_idle` |
| `done` and no events for `DONE_TO_IDLE_MS` (5 min) — finished, nobody prompted | `idle` ("Whistling") | `session_idle` |
| No events for `REMOVE_AFTER_MS` (30 min)                     | removed    | `session_removed` |

### Other per-session fields (2026-10-14)

| Field        | Source                                                  | Rule |
| ------------ | ------------------------------------------------------- | ---- |
| `cwd`        | `cwd` on `user`/`assistant` lines                        | Latest value wins — it moves when the session `cd`s. |
| `rootCwd`    | first `cwd` seen                                         | Never changes after it is set (the launch directory). |
| `gitBranch`  | `gitBranch` on `user`/`assistant` lines                  | Latest value wins. |
| `customTitle`| `custom-title` / `agent-name` lines                      | Latest wins; null until the user runs `/rename`. |
| `startedAt`  | min `timestamp` observed                                 | For files loaded at startup only the `STARTUP_TAIL_BYTES` tail is read, so old sessions start "late". |

### Live processes (2026-10-14)

Claude Code writes `<claudeDir>/sessions/<pid>.json` for every running process
(`{ pid, sessionId, cwd, name, nameSource: 'user'|'derived', status: 'busy'|'idle'|'shell',
startedAt, updatedAt, … }`) and deletes it on exit. `server/src/sessions.ts` polls these
every `LIVE_POLL_INTERVAL_MS` (3 s), drops entries whose pid is gone (`process.kill(pid, 0)`),
and feeds `AgentStore.applyLive()`:

| Field      | Rule |
| ---------- | ---- |
| `pid`      | Last known pid for the session. |
| `alive`    | True while the process runs. **Alive sessions are never removed**, however quiet their log; a dead one leaves `REMOVE_DEAD_AFTER_MS` (60 s) after it was last seen alive; log-only sessions keep the 30-min silence rule. |
| `ccStatus` | Claude's own status. `idle` while our status is thinking/running → we flip to `done` (+ `turn_done` event): it is waiting for the user. `busy` while we say idle/done → `thinking`. `busy` also blocks the 2-min idle rule. |
| `customTitle` | `name` when `nameSource === 'user'` (same value the `/rename` log lines carry). |
| `startedAt`  | min(log timestamp, `startedAt` from the file) — the true process start. |

The watcher is told the live session ids (`setLiveSessions`) so their log files are tailed and
polled even when older than `STARTUP_LOOKBACK_MS`. A session never seen in any log still
appears as a hero from the live file alone (status `done` or `thinking` from `ccStatus`).

### Squires — background sub-agents (2026-10-14)

Sub-agent transcripts live at `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl`
with a sibling `agent-<id>.meta.json` (`description` = the Agent tool's description). The
main log only records the launch; a *background* agent keeps running after the main turn
ends, so `stop_reason: end_turn` (and Claude's own `idle`) would wrongly read as "done".

`server/src/squires.ts` scans those folders every `SQUIRE_POLL_INTERVAL_MS` (5 s) for alive /
recently active sessions. A squire is **active** when its file was modified within
`SQUIRE_FRESH_MS` (60 s) or its last `stop_reason` isn't `end_turn`; older than
`SQUIRE_STALE_MS` (15 min) it is dropped. `AgentState.squires` carries the roster and:

| Situation | Status |
| --- | --- |
| main turn ends (`end_turn` / cc `idle`) while a squire is active | `delegating` (not `done`; no `turn_done`, no reward, no "Your turn") |
| last active squire finishes | `delegating` → `done` + `turn_done` "Squires returned" (this is the real finish — rewards and the needs-you cue fire here) |
| `delegating` with a silent main log | never idled by the 2-min rule |

Client: `STATUS_LABELS` gives the game words (done = "Awaiting quest" ✓, idle = "Idle",
delegating = "Awaiting squire"); the hero stays at its building doing the castle (banner)
action because the last tool was `Agent`.

**Monsters.** A `tool_error` event sets `lastError = { tool, detail, ts }` and bumps
`errorStreak`; the next `tool_done` or `turn_done` clears both. The client spawns a monster
beside the hero while `lastError` is set (streak 1 = bug, 2 = goblin, 3+ = ogre) and plays
its death when it clears. Sprites live in `client/public/assets/monsters/`.

**Forked squires.** The desktop's *Fetch Squire* runs `claude --resume <parent> --fork-session
--name "Squire of <parent name>"`. The store links any session whose `customTitle` matches
`SQUIRE_NAME_RE` to the hero with that name: `isSquire = true`, `squireOf = <parent sessionId>`
(null if the parent isn't on the map). New sessions started from the app are named
`Nameless` (`--name Nameless`); the client shows `customTitle ?? 'Nameless'`.

### Rewards & journal (2026-10-14)

`server/src/rewards.ts` listens to feed events: each `turn_done` on a session (≤ 1 per
`AWARD_COOLDOWN_MS`) rolls one crafting item from `CATALOG` (rarity weights 70/20/8/2,
70 % biased to the session's last tool category) and appends a `JournalEntry` (turn summary =
the event `detail`, now up to `MAX_DETAIL_LEN` = 200 chars). State persists to
`~/.rts-agents/rewards.json`; the client gets it in the `snapshot` (`rewards`), via
`GET /api/rewards`, and as `{ type: 'rewards', rewards, award }` after every award.

### Move into the village (2026-10-28)

Desktop bridge `releaseSession({ pid, sessionId })` (`desktop/src/release.ts`, IPC `session:release`)
closes an outside claude so the drawer can resume the same session (two processes on one session
corrupt turns). Refused unless the pid is not one of our ptys, its image is `claude(.exe)`, and
`<config>/sessions/<pid>.json` names `sessionId`; then `taskkill /PID <pid> /T /F` (claude and its
children only — the hosting terminal stays) and waits ≤ 8 s for the exit. `ok` with reason `gone` when
it had already exited. Client (`TerminalPanel`): "outside" = alive, logged, pid not ours; a session
whose turn is over (`ccStatus idle`, not `delegating`) moves at once, one at a time; the rest wait
and move when their turn ends (cancellable). Released pids count as gone while the server still lists
them (≤ `LIVE_POLL_INTERVAL_MS`). Resumes share Rally's staggered asleep-tab path.

### Rally — reopen what a power cut killed (2026-10-28)

`server/src/rally.ts` keeps a roster of every session seen running in `~/.rts-agents/rally.json`
(rewritten when the running set changes and every `RALLY_HEARTBEAT_MS` = 30 s; temp file + fsync +
rename, so a power cut mid-write never corrupts it). On boot, the sessions listed as running at the
file's last save get `cutAt` = that save time; the flag survives later restarts until the session
runs again. `GET /api/rally` → `RallyResponse`:

| Field | Rule |
| --- | --- |
| `sessions[].openAtCut` | Was running when the server last stopped. Always offered. |
| other `sessions[]` | Closed within `RALLY_WINDOW_MS` (3 h) of now, or of the cut. |
| excluded | Running now; never wrote a transcript (`claude --resume` would fail); older than `RALLY_KEEP_MS` (7 d). |

Client: `hooks/useRally.ts` fetches on connect and whenever the running set changes; dismissals
live in `rts-agents.ui.rally-dismissed` (sessionId → dismissed `lastAliveAt`). `RallyCard` (party
bar) preselects the cut casualties (or everything recent when there was no cut); **Rally** adds an
asleep resume tab per session (reusing an existing one) and wakes them `RALLY_STAGGER_MS` (700 ms)
apart through the normal restored-tab path (transcript-folder lookup, then `claude --resume`).

The client maps `cwd` → a place on the map through `client/src/world/registry.ts`
(`resolveAgentPlace`: latest cwd, then `rootCwd`, then title keywords). Flavour
lines ("Hammering code…") are client-side (`utils/flavor.ts`) — Claude Code's
spinner verbs are never written to the log.

`detail` extraction from `tool_use.input` (truncate to `MAX_DETAIL_LEN`):
`file_path` → basename; `command` → first chars; `pattern`/`query`/`url` →
verbatim; `description`/`prompt` (Task) → description; `todos` → `"N todos"`;
otherwise first string value found, else null.

## Server modules

- **`src/types.ts`** — wire types + tuning constants. Any shape change must be mirrored in `client/src/types/agent.ts` and noted in this file.
- **`src/state.ts`** — `AgentStore`: in-memory `Map<sessionId, AgentState>`,
  ring buffer of `MAX_EVENTS` activity events, `subscribe()` for change
  notification (used by index.ts to broadcast), periodic sweep (every 15 s)
  applying idle/remove rules. Pure state — no I/O.
- **`src/parser.ts`** — `SessionParser`: per-file incremental JSONL parsing.
  Handles partial trailing lines (carry buffer), huge lines, malformed JSON
  (skip, never throw). Emits typed parse results the store consumes.
- **`src/watcher.ts`** — discovery + tailing. Discover `<home>/.claude*`
  dirs at startup **and** every 10 s (new installs and new project dirs appear
  live). `fs.watch` (recursive where supported) with a polling rescan fallback;
  per-file byte offsets; on change, read only appended bytes
  (handle truncation: if file shrank, reset offset). On startup only load files
  modified within `STARTUP_LOOKBACK_MS`, reading at most `STARTUP_TAIL_BYTES`
  from the tail (skip the first partial line).
- **`src/index.ts`** — wires it all: env loading, Bun.serve (REST + WS),
  broadcast throttling, LAN URLs, graceful shutdown.

Server constraints: Bun built-ins only (`node:fs`, `node:path`, `node:os` are
fine). Strict TS. Must run on macOS, Linux **and Windows** (use
`os.homedir()` + `path.join`; never hard-code `/` or `~`).

## Client modules

- **`src/types/agent.ts`** — wire types + `BuildingId` (already written).
- **`src/utils/spriteMapper.ts`** — tool name → `BuildingId`:
  - `library`: Read, Glob, LS, Grep, NotebookRead
  - `forge`: Edit, Write, MultiEdit, NotebookEdit
  - `arena`: Bash, PowerShell, BashOutput, KillShell, Execute
  - `castle`: Task, Agent, Workflow
  - `watchtower`: TodoRead, TodoWrite, EnterPlanMode, ExitPlanMode
  - `chapel`: WebSearch, WebFetch
  - `alchemist`: anything else (MCP `mcp__*`, ToolSearch, Skill, …)
  - Status overrides: `idle`/`done` → `tavern`. `thinking` with no prior tool →
    village square (no building).
- **`src/hooks/useAgentSocket.ts`** — connect to
  `VITE_SERVER_URL ?? http://<location.hostname>:4444` (http→ws scheme),
  exponential backoff reconnect (1s→30s, jitter), exposes
  `{ agents, events, claudeDirs, connection }` where `connection` is a
  `ConnectionStatus`. Handles `shutdown` → `server-shutdown`.
- **Components** — `Village` (canvas), `PartyBar`, `ActivityFeed`, `TopBar`,
  `MapEditor` per the main spec. Canvas: `imageSmoothingEnabled = false`,
  CSS `image-rendering: pixelated`. No UI libraries.
- Map editor saves layout to localStorage key **`rts-agents.layout.v2`**
  (`Record<placeId, {tx, ty}>` in tile coords — whole places, not buildings) with a
  reset-to-default button. Other client keys: `rts-agents.wild-places.v1` (auto-discovered
  places), `rts-agents.hero-spots.v1` (where the user dragged each idle hero on the tavern
  plaza, stored as offsets from the plaza centre), `rts-agents.sound.v1`,
  `rts-agents.drawer.v1`, `rts-agents.feed.v1`.

## Status colours (used by PartyBar dots, hero labels, feed)

thinking `#a78bfa` · running `#60a5fa` · done `#4ade80` · idle `#9ca3af` · error `#f87171`
