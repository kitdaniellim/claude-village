// AgentStore — pure in-memory session state. No I/O.
// Map<sessionId, AgentState> + ring buffer of activity events + change
// subscription + a 15 s sweep applying the idle/remove rules from PROTOCOL.md.

import type { ActivityEvent, ActivityKind, AgentState, SquireInfo } from './types';
import {
  DONE_TO_IDLE_MS,
  IDLE_AFTER_MS,
  MAX_EVENTS,
  REMOVE_AFTER_MS,
  REMOVE_DEAD_AFTER_MS,
  SQUIRE_NAME_RE,
} from './types';
import type { SessionUpdate } from './parser';
import { lastPathSegment } from './parser';
import type { LiveSession } from './sessions';

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
  /** sessionId → when its process was last seen alive (drives REMOVE_DEAD_AFTER_MS). */
  private readonly lastAliveAt = new Map<string, number>();
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

  getAgent(sessionId: string): AgentState | undefined {
    const a = this.agents.get(sessionId);
    return a ? { ...a } : undefined;
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

  private createAgent(sessionId: string, installDir: string, project: string, ts: number): AgentState {
    const agent: AgentState = {
      sessionId,
      shortId: sessionId.slice(0, 8),
      title: null,
      customTitle: null,
      installDir,
      project,
      cwd: null,
      rootCwd: null,
      gitBranch: null,
      workPath: null,
      recentPaths: [],
      lastText: null,
      pid: null,
      alive: false,
      ccStatus: null,
      squires: [],
      squireOf: null,
      isSquire: false,
      lastError: null,
      errorStreak: 0,
      status: 'thinking',
      tool: null,
      detail: null,
      model: null,
      lastEventAt: ts,
      startedAt: ts,
      eventCount: 0,
    };
    this.agents.set(sessionId, agent);
    return agent;
  }

  /**
   * Reconcile with the live-process list. Live sessions are created if the log
   * never produced them, get pid/name/cwd/ccStatus, and are pinned on the map;
   * sessions whose process is gone are marked dead and swept later.
   */
  applyLive(sessions: LiveSession[], now: number = Date.now()): void {
    const live = new Set<string>();
    let changed = false;
    for (const s of sessions) {
      live.add(s.sessionId);
      this.lastAliveAt.set(s.sessionId, now);
      let agent = this.agents.get(s.sessionId);
      if (!agent) {
        const ts = s.updatedAt ?? s.startedAt ?? now;
        agent = this.createAgent(s.sessionId, s.installDir, s.cwd ? lastPathSegment(s.cwd) : '?', ts);
        agent.status = s.status === 'busy' ? 'thinking' : 'done';
        changed = true;
        this.pushEvent(agent.sessionId, agent.shortId, ts, 'session_new', null, agent.project);
      }
      if (agent.pid !== s.pid || !agent.alive) changed = true;
      agent.pid = s.pid;
      agent.alive = true;
      if (s.cwd && agent.rootCwd === null) {
        agent.rootCwd = s.cwd;
        if (agent.cwd === null) {
          agent.cwd = s.cwd;
          agent.project = lastPathSegment(s.cwd);
        }
        changed = true;
      }
      if (s.name && s.nameSource === 'user' && agent.customTitle !== s.name) {
        agent.customTitle = s.name;
        this.linkSquires();
        changed = true;
      }
      if (s.startedAt !== null && s.startedAt < agent.startedAt) {
        agent.startedAt = s.startedAt;
        changed = true;
      }
      if (agent.ccStatus !== s.status) {
        const prev = agent.ccStatus;
        agent.ccStatus = s.status;
        changed = true;
        // Claude's own status is the truth about "waiting for you" vs "working" — use it to
        // correct a log-derived status that went stale (e.g. a turn that ended without a tool).
        if (s.status === 'idle' && (agent.status === 'thinking' || agent.status === 'running')) {
          if (this.hasActiveSquire(agent)) {
            agent.status = 'delegating';
          } else {
            agent.status = 'done';
            this.pushEvent(agent.sessionId, agent.shortId, now, 'turn_done', null, agent.lastText);
          }
        } else if (s.status === 'busy' && prev !== null && (agent.status === 'idle' || agent.status === 'done' || agent.status === 'delegating')) {
          agent.status = 'thinking';
        }
      }
    }
    for (const agent of this.agents.values()) {
      if (agent.alive && !live.has(agent.sessionId)) {
        agent.alive = false;
        changed = true;
      }
    }
    if (changed) this.notify(true, null);
  }

  /**
   * Sub-agent roster from the scanner. While any squire is active a finished
   * main turn shows as `delegating`, not `done`; when the last squire returns
   * the hero is finally done and the feed says so.
   */
  applySquires(sessionId: string, squires: SquireInfo[], now: number = Date.now()): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    agent.squires = squires;
    const active = squires.some((s) => s.active);
    if (active && (agent.status === 'done' || agent.status === 'idle')) {
      agent.status = 'delegating';
    } else if (!active && agent.status === 'delegating') {
      agent.status = 'done';
      this.pushEvent(agent.sessionId, agent.shortId, now, 'turn_done', null, 'Squires returned — quest complete');
    }
    this.notify(true, null);
  }

  private hasActiveSquire(agent: AgentState): boolean {
    return agent.squires.some((s) => s.active);
  }

  /** Link "Squire of <name>" sessions to the hero with that name (re-run whenever a name changes). */
  private linkSquires(): void {
    const byName = new Map<string, string>();
    for (const a of this.agents.values()) {
      const name = a.customTitle ?? a.title;
      if (name && !SQUIRE_NAME_RE.test(name)) byName.set(name, a.sessionId);
    }
    for (const a of this.agents.values()) {
      const m = a.customTitle ? SQUIRE_NAME_RE.exec(a.customTitle) : null;
      a.isSquire = m !== null;
      a.squireOf = m ? (byName.get(m[1] as string) ?? null) : null;
      // "Squire of Nameless": the parent had no /rename, so match an unnamed hero in the same folder.
      if (m && a.squireOf === null && m[1] === 'Nameless') {
        let best: AgentState | null = null;
        for (const p of this.agents.values()) {
          const unnamed = p.customTitle === null || p.customTitle === 'Nameless';
          const sameDir = p.rootCwd !== null && (p.rootCwd === a.rootCwd || p.cwd === a.rootCwd);
          if (p !== a && unnamed && !SQUIRE_NAME_RE.test(p.customTitle ?? '') && sameDir) {
            if (!best || p.lastEventAt > best.lastEventAt) best = p;
          }
        }
        a.squireOf = best?.sessionId ?? null;
      }
    }
  }

  applyUpdate(meta: SessionMeta, u: SessionUpdate): void {
    let agent = this.agents.get(meta.sessionId);
    const created = agent === undefined;
    if (!agent) agent = this.createAgent(meta.sessionId, meta.installDir, meta.projectDir, u.ts);

    agent.eventCount += 1;
    if (u.ts > agent.lastEventAt) agent.lastEventAt = u.ts;
    if (u.ts < agent.startedAt) agent.startedAt = u.ts;
    if (u.cwd) {
      agent.cwd = u.cwd;
      if (agent.rootCwd === null) agent.rootCwd = u.cwd;
      agent.project = lastPathSegment(u.cwd);
    }
    if (u.gitBranch) agent.gitBranch = u.gitBranch;
    if (u.lastText) agent.lastText = u.lastText;
    if (u.workPaths && u.workPaths.length > 0) {
      agent.workPath = u.workPaths[0] as string;
      const keys = new Set(u.workPaths.map((p) => p.toLowerCase()));
      agent.recentPaths = [...u.workPaths, ...agent.recentPaths.filter((p) => !keys.has(p.toLowerCase()))].slice(0, 8);
    }
    if (u.customTitle !== undefined) {
      agent.customTitle = u.customTitle;
      this.linkSquires();
    }
    if (u.model) agent.model = u.model;
    // A turn that ends while squires are still out isn't finished yet.
    if (u.status !== undefined) agent.status = u.status === 'done' && this.hasActiveSquire(agent) ? 'delegating' : u.status;
    if (u.tool !== undefined) agent.tool = u.tool;
    if (u.detail !== undefined) agent.detail = u.detail;
    // Monsters: a tool error spawns one (streak sets its size); the next success or turn end slays it.
    for (const ev of u.events) {
      if (ev.kind === 'tool_error') {
        agent.lastError = { tool: ev.tool, detail: ev.detail, ts: u.ts, path: ev.paths?.[0] ?? agent.workPath };
        agent.errorStreak += 1;
      } else if (ev.kind === 'tool_done' || ev.kind === 'turn_done') {
        agent.lastError = null;
        agent.errorStreak = 0;
      }
    }

    const rank = this.titleRanks.get(meta.sessionId) ?? 0;
    let titleChanged = false;
    if (u.aiTitle !== undefined) {
      agent.title = u.aiTitle;
      this.titleRanks.set(meta.sessionId, RANK_AI_TITLE);
      titleChanged = true;
    } else if (u.promptTitle !== undefined && rank < RANK_PROMPT) {
      agent.title = u.promptTitle;
      this.titleRanks.set(meta.sessionId, RANK_PROMPT);
      titleChanged = true;
    } else if (u.lastPromptTitle !== undefined && rank <= RANK_LAST_PROMPT) {
      agent.title = u.lastPromptTitle;
      this.titleRanks.set(meta.sessionId, RANK_LAST_PROMPT);
      titleChanged = true;
    }
    if (titleChanged) this.linkSquires();

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
      const seenAlive = this.lastAliveAt.get(sessionId);
      // Live processes stay however quiet; a dead one leaves REMOVE_DEAD_AFTER_MS after it
      // was last seen alive; sessions we only know from logs use the silence rule.
      const remove = agent.alive
        ? false
        : seenAlive !== undefined
          ? now - seenAlive >= REMOVE_DEAD_AFTER_MS
          : age >= REMOVE_AFTER_MS;
      if (remove) {
        this.agents.delete(sessionId);
        this.titleRanks.delete(sessionId);
        this.lastAliveAt.delete(sessionId);
        agentsChanged = true;
        this.pushEvent(sessionId, agent.shortId, now, 'session_removed', null, agent.project);
      } else if (
        agent.ccStatus !== 'busy' &&
        agent.status !== 'error' &&
        agent.status !== 'idle' &&
        agent.status !== 'delegating' && // the main log is silent while squires work
        // Finished heroes wait a while for orders before they start whistling.
        age >= (agent.status === 'done' ? DONE_TO_IDLE_MS : IDLE_AFTER_MS)
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
    if (kind === 'turn_done') {
      const a = this.agents.get(sessionId);
      if (a) a.lastTurnDoneAt = ts;
    }
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
