// AgentStore — pure in-memory session state. No I/O.
// Map<sessionId, AgentState> + ring buffer of activity events + change
// subscription + a 15 s sweep applying the idle/remove rules from PROTOCOL.md.

import type { ActivityEvent, ActivityKind, AgentState } from './types';
import { IDLE_AFTER_MS, MAX_EVENTS, REMOVE_AFTER_MS } from './types';
import type { SessionUpdate } from './parser';
import { lastPathSegment } from './parser';

const SWEEP_INTERVAL_MS = 15_000;

// Title precedence ranks: ai-title (3) > first real prompt snippet (2) > last-prompt (1).
const RANK_AI_TITLE = 3;
const RANK_PROMPT = 2;
const RANK_LAST_PROMPT = 1;

/** Identifies which file/session an update belongs to (supplied by the watcher). */
export interface SessionMeta {
  sessionId: string;
  /** Basename of the install dir, e.g. ".claude" or ".claude-work". */
  installDir: string;
  /** Project slug dir name — fallback for `project` until a cwd is seen in the log. */
  projectDir: string;
}

/**
 * Called on every store change: `agentsChanged` when any AgentState mutated
 * (broadcasts are throttled by the caller), `event` when a feed event was added.
 */
export type StoreListener = (agentsChanged: boolean, event: ActivityEvent | null) => void;

export class AgentStore {
  private readonly agents = new Map<string, AgentState>();
  /** sessionId → title precedence rank currently applied (internal, not on the wire). */
  private readonly titleRanks = new Map<string, number>();
  private readonly events: ActivityEvent[] = [];
  private readonly listeners = new Set<StoreListener>();
  private eventSeq = 0;
  private listenerErrors = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getAgents(): AgentState[] {
    // Shallow clones: the store mutates AgentState in place, so callers get
    // point-in-time snapshots they can safely hold across ticks/awaits.
    return [...this.agents.values()].map((a) => ({ ...a }));
  }

  getEvents(): ActivityEvent[] {
    return [...this.events];
  }

  /** Stop the sweep timer (graceful shutdown). */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  applyUpdates(meta: SessionMeta, updates: SessionUpdate[]): void {
    for (const update of updates) this.applyUpdate(meta, update);
  }

  applyUpdate(meta: SessionMeta, u: SessionUpdate): void {
    let agent = this.agents.get(meta.sessionId);
    const created = agent === undefined;
    if (!agent) {
      agent = {
        sessionId: meta.sessionId,
        shortId: meta.sessionId.slice(0, 8),
        title: null,
        customTitle: null,
        installDir: meta.installDir,
        project: meta.projectDir,
        cwd: null,
        rootCwd: null,
        gitBranch: null,
        status: 'thinking',
        tool: null,
        detail: null,
        model: null,
        lastEventAt: u.ts,
        startedAt: u.ts,
        eventCount: 0,
      };
      this.agents.set(meta.sessionId, agent);
    }

    agent.eventCount += 1;
    if (u.ts > agent.lastEventAt) agent.lastEventAt = u.ts;
    if (u.ts < agent.startedAt) agent.startedAt = u.ts;
    if (u.cwd) {
      agent.cwd = u.cwd;
      if (agent.rootCwd === null) agent.rootCwd = u.cwd;
      agent.project = lastPathSegment(u.cwd);
    }
    if (u.gitBranch) agent.gitBranch = u.gitBranch;
    if (u.customTitle !== undefined) agent.customTitle = u.customTitle;
    if (u.model) agent.model = u.model;
    if (u.status !== undefined) agent.status = u.status;
    if (u.tool !== undefined) agent.tool = u.tool;
    if (u.detail !== undefined) agent.detail = u.detail;

    const rank = this.titleRanks.get(meta.sessionId) ?? 0;
    if (u.aiTitle !== undefined) {
      agent.title = u.aiTitle;
      this.titleRanks.set(meta.sessionId, RANK_AI_TITLE);
    } else if (u.promptTitle !== undefined && rank < RANK_PROMPT) {
      agent.title = u.promptTitle;
      this.titleRanks.set(meta.sessionId, RANK_PROMPT);
    } else if (u.lastPromptTitle !== undefined && rank <= RANK_LAST_PROMPT) {
      agent.title = u.lastPromptTitle;
      this.titleRanks.set(meta.sessionId, RANK_LAST_PROMPT);
    }

    this.notify(true, null);

    if (created) {
      this.pushEvent(agent.sessionId, agent.shortId, u.ts, 'session_new', null, agent.project);
    }
    for (const ev of u.events) {
      this.pushEvent(agent.sessionId, agent.shortId, u.ts, ev.kind, ev.tool, ev.detail);
    }
  }

  /** Apply idle/remove rules. Exposed (with injectable clock) for testability. */
  sweep(now: number = Date.now()): void {
    let agentsChanged = false;
    for (const [sessionId, agent] of [...this.agents]) {
      const age = now - agent.lastEventAt;
      if (age >= REMOVE_AFTER_MS) {
        this.agents.delete(sessionId);
        this.titleRanks.delete(sessionId);
        agentsChanged = true;
        this.pushEvent(sessionId, agent.shortId, now, 'session_removed', null, agent.project);
      } else if (
        age >= IDLE_AFTER_MS &&
        agent.status !== 'done' &&
        agent.status !== 'error' &&
        agent.status !== 'idle'
      ) {
        agent.status = 'idle';
        agentsChanged = true;
        this.pushEvent(sessionId, agent.shortId, now, 'session_idle', null, agent.project);
      }
    }
    if (agentsChanged) this.notify(true, null);
  }

  private pushEvent(
    sessionId: string,
    shortId: string,
    ts: number,
    kind: ActivityKind,
    tool: string | null,
    detail: string | null
  ): void {
    const event: ActivityEvent = {
      id: `e${++this.eventSeq}`,
      sessionId,
      shortId,
      ts,
      kind,
      tool,
      detail,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.notify(false, event);
  }

  private notify(agentsChanged: boolean, event: ActivityEvent | null): void {
    for (const listener of this.listeners) {
      try {
        listener(agentsChanged, event);
      } catch (err) {
        // Listeners must never break the store — but the sole production
        // listener is the broadcast path, so a failure must be visible.
        this.listenerErrors += 1;
        if (this.listenerErrors === 1 || this.listenerErrors % 100 === 0) {
          console.error(`[rts-agents] store listener failed (${this.listenerErrors}x):`, err);
        }
      }
    }
  }
}
