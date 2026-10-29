// Wire protocol shared with the server (mirrored in server/src/types.ts).
// Any change here must be applied to both files — see PROTOCOL.md.

export type AgentStatus = 'thinking' | 'running' | 'done' | 'idle' | 'error';

export interface AgentState {
  sessionId: string;
  shortId: string;
  title: string | null;
  customTitle: string | null;
  installDir: string;
  project: string;
  cwd: string | null;
  rootCwd: string | null;
  gitBranch: string | null;
  status: AgentStatus;
  tool: string | null;
  detail: string | null;
  model: string | null;
  lastEventAt: number;
  startedAt: number;
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
  id: string;
  sessionId: string;
  shortId: string;
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

export interface AgentsResponse {
  agents: AgentState[];
  events: ActivityEvent[];
  claudeDirs: string[];
  serverTime: number;
}

// ── Village vocabulary ───────────────────────────────────────────────────────

export type BuildingId =
  | 'library'
  | 'forge'
  | 'arena'
  | 'castle'
  | 'watchtower'
  | 'tavern'
  | 'chapel'
  | 'alchemist';

export interface BuildingInfo {
  id: BuildingId;
  name: string;
  /** Tools that route heroes to this building (display only). */
  caption: string;
}

/** Connection lifecycle for the WebSocket hook. */
export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'server-shutdown';
