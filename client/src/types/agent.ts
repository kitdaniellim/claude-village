// Wire protocol shared with the server (mirrored in server/src/types.ts).
// Any change here must be applied to both files — see PROTOCOL.md.

/** `delegating` = the main turn ended but a background sub-agent ("squire") is still working. */
export type AgentStatus = 'thinking' | 'running' | 'done' | 'idle' | 'error' | 'delegating';

export interface SquireInfo {
  id: string;
  description: string | null;
  active: boolean;
  lastActiveAt: number;
}

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
  workPath: string | null;
  recentPaths: string[];
  lastText: string | null;
  pid: number | null;
  alive: boolean;
  ccStatus: 'busy' | 'idle' | 'shell' | null;
  squires: SquireInfo[];
  squireOf: string | null;
  isSquire: boolean;
  lastError: { tool: string | null; detail: string | null; ts: number; path: string | null } | null;
  errorStreak: number;
  status: AgentStatus;
  tool: string | null;
  detail: string | null;
  model: string | null;
  lastEventAt: number;
  /** When the session last finished a turn (turn_done), or null — the Party Leader reviews these. */
  lastTurnDoneAt?: number | null;
  /** When the human last typed a prompt into this session — supersedes an older needs-you verdict. */
  lastHumanPromptAt?: number | null;
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

/** A Party Leader's verdict on a worker session (POST /api/review, GET /api/reviews). */
export interface ReviewVerdict {
  sessionId: string;
  verdict: 'approved' | 'changes' | 'needs-you';
  /** Short note: what to fix, why it's approved, or what the human must decide. */
  note: string;
  /** Review round for this worker (1 = first review of the current task). */
  round: number;
  /** needs-you: the exact replies the worker asked for ("apply it"), offered as one-click buttons. */
  replies?: string[];
  at: number;
  /** The worker's lastTurnDoneAt when the verdict landed — the turn it judged. A human prompt after
   *  this settles a needs-you verdict. */
  turnDoneAt?: number;
}

export interface ReviewsResponse {
  verdicts: ReviewVerdict[];
}
