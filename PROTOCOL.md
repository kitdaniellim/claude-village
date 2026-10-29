# RTS Agents — Internal Protocol & Module Contracts

This document is the single source of truth for how the server and client talk,
and what each module is responsible for. The wire types live in
`server/src/types.ts` and `client/src/types/agent.ts` (kept identical by hand).

## Transport

- Server: `Bun.serve` on `PORT` (default **4444**). Native Bun WebSocket (no `ws` package).
- WebSocket endpoint: `GET /ws` (upgrade). REST: `GET /api/agents`, `GET /healthz`.
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
| No events for `IDLE_AFTER_MS` (2 min) and status ≠ done/error | `idle`    | `session_idle` |
| No events for `REMOVE_AFTER_MS` (30 min)                     | removed    | `session_removed` |

### Other per-session fields (2026-10-14)

| Field        | Source                                                  | Rule |
| ------------ | ------------------------------------------------------- | ---- |
| `cwd`        | `cwd` on `user`/`assistant` lines                        | Latest value wins — it moves when the session `cd`s. |
| `rootCwd`    | first `cwd` seen                                         | Never changes after it is set (the launch directory). |
| `gitBranch`  | `gitBranch` on `user`/`assistant` lines                  | Latest value wins. |
| `customTitle`| `custom-title` / `agent-name` lines                      | Latest wins; null until the user runs `/rename`. |
| `startedAt`  | min `timestamp` observed                                 | For files loaded at startup only the `STARTUP_TAIL_BYTES` tail is read, so old sessions start "late". |

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
- Map editor saves layout to localStorage key **`rts-agents.layout.v1`**
  (`Record<BuildingId, {tx, ty}>` in tile coords) with a reset-to-default button.

## Status colours (used by PartyBar dots, hero labels, feed)

thinking `#a78bfa` · running `#60a5fa` · done `#4ade80` · idle `#9ca3af` · error `#f87171`
