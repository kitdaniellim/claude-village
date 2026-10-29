// Wire protocol shared with the client (mirrored in client/src/types/agent.ts).
// Any change here must be applied to both files — see PROTOCOL.md.

export type AgentStatus = 'thinking' | 'running' | 'done' | 'idle' | 'error';

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

export type ServerMessage =
  | {
      type: 'snapshot';
      agents: AgentState[];
      events: ActivityEvent[];
      claudeDirs: string[];
      serverTime: number;
    }
  | { type: 'agents'; agents: AgentState[] }
  | { type: 'event'; event: ActivityEvent }
  | { type: 'meta'; claudeDirs: string[] }
  | { type: 'shutdown' };

/** REST shape for GET /api/agents. */
export interface AgentsResponse {
  agents: AgentState[];
  events: ActivityEvent[];
  claudeDirs: string[];
  serverTime: number;
}

// ── Tuning constants ─────────────────────────────────────────────────────────

/** A session with no new events for this long is marked idle. */
export const IDLE_AFTER_MS = 120_000;
/** A session with no new events for this long is removed from the village. */
export const REMOVE_AFTER_MS = 30 * 60_000;
/** On startup, only session files modified within this window are loaded. */
export const STARTUP_LOOKBACK_MS = 30 * 60_000;
/** On startup, read at most this many trailing bytes of each existing file. */
export const STARTUP_TAIL_BYTES = 256 * 1024;
/** Agent-list broadcasts are coalesced to at most one per this interval. */
export const BROADCAST_THROTTLE_MS = 250;
/** Activity feed ring buffer size (server keeps + snapshot sends this many). */
export const MAX_EVENTS = 50;
/** Max length of AgentState.detail / ActivityEvent.detail. */
export const MAX_DETAIL_LEN = 80;
