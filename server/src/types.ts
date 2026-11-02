// Wire protocol shared with the client (mirrored in client/src/types/agent.ts).
// Any change here must be applied to both files — see PROTOCOL.md.

/** `delegating` = the main turn ended but a background sub-agent ("squire") is still working. */
export type AgentStatus = 'thinking' | 'running' | 'done' | 'idle' | 'error' | 'delegating';

/** A sub-agent transcript under `<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl`. */
export interface SquireInfo {
  id: string;
  /** From the sibling `.meta.json` (the Agent tool's description), or null. */
  description: string | null;
  /** True while its transcript keeps growing / hasn't reached `end_turn`. */
  active: boolean;
  lastActiveAt: number;
}

export interface AgentState {
  /** Full session UUID (the JSONL file name). */
  sessionId: string;
  /** First 8 chars of sessionId, shown above the hero sprite. */
  shortId: string;
  /** Session title from `ai-title` log lines, falling back to the first prompt snippet. */
  title: string | null;
  /** User-chosen name from `custom-title` / `agent-name` lines (the /rename command). Null until renamed. */
  customTitle: string | null;
  /** Which install the session belongs to, e.g. ".claude" or ".claude-work". */
  installDir: string;
  /** Basename of the session's cwd (the project the agent is working in). */
  project: string;
  /** Latest absolute cwd seen in the log — moves when the session `cd`s. */
  cwd: string | null;
  /** First cwd seen in the log — the directory the session was launched from. */
  rootCwd: string | null;
  /** Git branch stamped on the most recent log line that carried one. */
  gitBranch: string | null;
  /** Absolute path the latest tool touched — places a hero whose `cwd` stays at the coding root. */
  workPath: string | null;
  /** Distinct recent tool paths, newest first (≤ 8) — the client picks the newest that lands in a project. */
  recentPaths: string[];
  /** Latest assistant prose (the closing summary of the last finished turn). Server-side only use. */
  lastText: string | null;
  /** OS pid of the Claude Code process (from `<claudeDir>/sessions/<pid>.json`), last known. */
  pid: number | null;
  /** True while that process is running — such sessions stay on the map however quiet the log is. */
  alive: boolean;
  /** Claude Code's own status from the session file: `busy` (working), `idle` (waiting for you), `shell`. */
  ccStatus: 'busy' | 'idle' | 'shell' | null;
  /** Sub-agents seen for this session (recent ones only); any `active` one keeps the hero `delegating`. */
  squires: SquireInfo[];
  /** Set when this session is a fork named "Squire of <parent>": the parent's sessionId (null if the parent isn't on the map). */
  squireOf: string | null;
  /** True when the name marks it as a squire, even if the parent has left. */
  isSquire: boolean;
  /** The unresolved tool error (a "monster" on the map); null once a later tool succeeds or the turn ends. */
  /** `path`: where the bug lives (the failing tool's file/dir), so the monster appears at that project. */
  lastError: { tool: string | null; detail: string | null; ts: number; path: string | null } | null;
  /** Consecutive tool errors without a success — decides how big the monster is. */
  errorStreak: number;
  status: AgentStatus;
  /** Current (or most recent) tool name, e.g. "Read", "Bash", "mcp__playwright__browser_click". */
  tool: string | null;
  /** Short human-readable snippet: file basename, command prefix, search query… (max ~80 chars). */
  detail: string | null;
  /** Model id from the last assistant message, if present. */
  model: string | null;
  /** Epoch ms of the last log event observed for this session. */
  lastEventAt: number;
  /** Epoch ms of the earliest log event observed for this session (within the startup tail for old files). */
  startedAt: number;
  /** Total parsed events attributed to this session since the server started. */
  eventCount: number;
}

export type ActivityKind =
  | 'tool_start'
  | 'tool_done'
  | 'tool_error'
  | 'thinking'
  | 'turn_done'
  | 'session_new'
  | 'session_idle'
  | 'session_removed';

export interface ActivityEvent {
  /** Unique id (monotonic counter is fine). */
  id: string;
  sessionId: string;
  shortId: string;
  /** Epoch ms. */
  ts: number;
  kind: ActivityKind;
  tool: string | null;
  detail: string | null;
}

// ── Rewards: items earned per finished turn + a per-project journal ──────────

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic';

export interface ItemDef {
  /** Stable id, also the key the client uses to pick the icon sprite. */
  id: string;
  name: string;
  rarity: ItemRarity;
  /** One-line flavour text for the inventory tooltip. */
  lore: string;
}

export interface InventoryEntry {
  /** Project (cwd basename) the item was earned in. */
  project: string;
  itemId: string;
  count: number;
  /** Epoch ms of the latest award. */
  lastAt: number;
}

export interface JournalEntry {
  id: string;
  ts: number;
  sessionId: string;
  shortId: string;
  sessionName: string | null;
  project: string;
  cwd: string | null;
  /** The finishing text of the turn (what the hero reported), or null. */
  summary: string | null;
  /** Item awarded for this turn, if any. */
  itemId: string | null;
}

export interface RewardsState {
  catalog: ItemDef[];
  inventory: InventoryEntry[];
  /** Newest first, capped per project. */
  journal: JournalEntry[];
}

export type ServerMessage =
  | {
      type: 'snapshot';
      agents: AgentState[];
      events: ActivityEvent[];
      claudeDirs: string[];
      serverTime: number;
      rewards: RewardsState;
    }
  | { type: 'agents'; agents: AgentState[] }
  | { type: 'event'; event: ActivityEvent }
  | { type: 'meta'; claudeDirs: string[] }
  /** Full rewards state after an award (small; the client replaces its copy). `award` names what was just earned. */
  | { type: 'rewards'; rewards: RewardsState; award: JournalEntry | null }
  | { type: 'shutdown' };

// ── Rally: reopen the sessions a power cut / restart killed ─────────────────

/** A session that was running recently and isn't now (GET /api/rally). */
export interface RallySession {
  sessionId: string;
  shortId: string;
  /** The /rename name, if any. */
  name: string | null;
  /** Auto title (prompt snippet / ai-title), for telling Nameless heroes apart. */
  title: string | null;
  cwd: string | null;
  /** Launch dir — `claude --resume` runs from here. */
  rootCwd: string | null;
  installDir: string;
  isSquire: boolean;
  /** Epoch ms it was last seen running. */
  lastAliveAt: number;
  /** It was still running when the server last stopped (power cut, reboot, app quit). */
  openAtCut: boolean;
}

export interface RallyResponse {
  /** When the server last stopped with sessions still running (newest such cut), or null. */
  cutAt: number | null;
  /** How far back "recently closed" reaches (before now, and before the cut). */
  windowMs: number;
  /** openAtCut first, then most recently alive. Never includes a session running now. */
  sessions: RallySession[];
  serverTime: number;
}

/** GET /api/names?ids=a,b — each session's latest `/rename` from its transcript (null = never named / not found). */
export interface NamesResponse {
  names: Record<string, string | null>;
}

/** REST shape for GET /api/agents. */
export interface AgentsResponse {
  agents: AgentState[];
  events: ActivityEvent[];
  claudeDirs: string[];
  serverTime: number;
  rewards: RewardsState;
}

// ── Tuning constants ─────────────────────────────────────────────────────────

/** A session with no new events for this long is marked idle. */
export const IDLE_AFTER_MS = 120_000;
/** A finished (`done`) hero that nobody prompts for this long starts whistling (`idle`). */
export const DONE_TO_IDLE_MS = 5 * 60_000;
/** Forked sessions are named "Squire of <parent>" by the desktop app. */
export const SQUIRE_NAME_RE = /^Squire of (.+)$/;
/** A session with no new events for this long is removed from the village (never while its process is alive). */
export const REMOVE_AFTER_MS = 30 * 60_000;
/** A session whose process has exited leaves the village this long after it was last seen alive. */
export const REMOVE_DEAD_AFTER_MS = 60_000;
/** How often `<claudeDir>/sessions/*.json` is re-read for live processes. */
export const LIVE_POLL_INTERVAL_MS = 3_000;
/** How often sub-agent transcripts are re-scanned. */
export const SQUIRE_POLL_INTERVAL_MS = 5_000;
/** A sub-agent transcript modified this recently counts as active without reading it. */
export const SQUIRE_FRESH_MS = 60_000;
/** Older than this, a sub-agent is considered finished whatever its last line says. */
export const SQUIRE_STALE_MS = 15 * 60_000;
/** On startup, only session files modified within this window are loaded. */
export const STARTUP_LOOKBACK_MS = 30 * 60_000;
/** On startup, read at most this many trailing bytes of each existing file. */
export const STARTUP_TAIL_BYTES = 256 * 1024;
/** Agent-list broadcasts are coalesced to at most one per this interval. */
export const BROADCAST_THROTTLE_MS = 250;
/** Activity feed ring buffer size (server keeps + snapshot sends this many). */
export const MAX_EVENTS = 50;
/** Max length of AgentState.detail / ActivityEvent.detail (turn summaries feed the journal, so it's roomy). */
export const MAX_DETAIL_LEN = 200;
/** Max length of a stored turn summary (journal / quest log); raw markdown, cleaned by the client. */
export const MAX_SUMMARY_LEN = 1200;
/** Journal entries kept per project. */
export const JOURNAL_PER_PROJECT = 100;
/** Two turn_done signals for one session inside this window count as one finished task. */
export const AWARD_COOLDOWN_MS = 15_000;
/** Rally: sessions closed this long before now (or before a power cut) are offered for reopening. */
export const RALLY_WINDOW_MS = 3 * 60 * 60_000;
/** Rally: the running set is rewritten to disk at least this often (and at once when it changes). */
export const RALLY_HEARTBEAT_MS = 30_000;
/** Rally: roster entries older than this are forgotten. */
export const RALLY_KEEP_MS = 7 * 24 * 60 * 60_000;
