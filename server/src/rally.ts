// Rally — remembers which Claude Code sessions were running, on disk, so that after a
// power cut (or any restart that killed them) the dashboard can reopen them in one click.
// Persisted to ~/.rts-agents/rally.json with a crash-safe write (fsync + rename).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentState, RallyResponse, RallySession } from './types';
import { RALLY_HEARTBEAT_MS, RALLY_KEEP_MS, RALLY_WINDOW_MS } from './types';

interface Entry {
  sessionId: string;
  name: string | null;
  title: string | null;
  cwd: string | null;
  rootCwd: string | null;
  installDir: string;
  isSquire: boolean;
  /** It wrote a transcript at some point — a claude that never logged can't be resumed. */
  logged: boolean;
  lastAliveAt: number;
  /** Set when the server stopped while this session was running: when it was last confirmed alive. */
  cutAt: number | null;
}

interface FileShape {
  v: 1;
  savedAt: number;
  /** Sessions running at `savedAt` — on the next boot these become "open when the village went dark". */
  alive: string[];
  entries: Entry[];
}

const MAX_ENTRIES = 100;
const CHECK_MS = 3_000;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseFile(raw: string): FileShape | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r['v'] !== 1 || !Array.isArray(r['entries'])) return null;
  const entries: Entry[] = [];
  for (const e of r['entries'] as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    const sessionId = str(x['sessionId']);
    if (!sessionId || !/^[\w-]+$/.test(sessionId) || typeof x['lastAliveAt'] !== 'number') continue;
    entries.push({
      sessionId,
      name: str(x['name']),
      title: str(x['title']),
      cwd: str(x['cwd']),
      rootCwd: str(x['rootCwd']),
      installDir: str(x['installDir']) ?? '.claude',
      isSquire: x['isSquire'] === true,
      logged: x['logged'] === true,
      lastAliveAt: x['lastAliveAt'],
      cutAt: typeof x['cutAt'] === 'number' ? x['cutAt'] : null,
    });
  }
  return {
    v: 1,
    savedAt: typeof r['savedAt'] === 'number' ? r['savedAt'] : 0,
    alive: Array.isArray(r['alive']) ? (r['alive'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    entries,
  };
}

export class Rally {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAliveKey = '';
  private lastWriteAt = 0;

  constructor(
    private readonly agents: () => AgentState[],
    private readonly file: string = path.join(os.homedir(), '.rts-agents', 'rally.json'),
  ) {
    this.load();
  }

  /** Read the last run's roster; whatever was running at its final save was cut off. */
  private load(): void {
    let prev: FileShape | null = null;
    try {
      prev = parseFile(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return; // first run, or unreadable — start empty
    }
    if (!prev) return;
    const cut = new Set(prev.alive);
    for (const e of prev.entries) {
      // Older cuts carry over until the session runs again, so a second restart doesn't forget them.
      this.entries.set(e.sessionId, cut.has(e.sessionId) ? { ...e, cutAt: prev.savedAt } : e);
    }
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), CHECK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Refresh every running session; write at once when the running set changes, else on the heartbeat. */
  private tick(now: number = Date.now()): void {
    const alive = this.agents().filter((a) => a.alive);
    for (const a of alive) {
      const prev = this.entries.get(a.sessionId);
      this.entries.set(a.sessionId, {
        sessionId: a.sessionId,
        name: a.customTitle,
        title: a.title ? a.title.slice(0, 120) : null,
        cwd: a.cwd,
        rootCwd: a.rootCwd,
        installDir: a.installDir,
        isSquire: a.isSquire,
        logged: (prev?.logged ?? false) || a.eventCount > 0 || a.title !== null,
        lastAliveAt: now,
        cutAt: null, // running again — no longer a casualty
      });
    }
    const key = alive
      .map((a) => a.sessionId)
      .sort()
      .join('|');
    if (key !== this.lastAliveKey || now - this.lastWriteAt >= RALLY_HEARTBEAT_MS) {
      this.lastAliveKey = key;
      this.save(now, alive.map((a) => a.sessionId));
    }
  }

  /** Crash-safe: write a temp file, fsync it, then rename over the old one (atomic on NTFS and POSIX). */
  private save(now: number, alive: string[]): void {
    for (const [id, e] of this.entries) {
      if (now - Math.max(e.lastAliveAt, e.cutAt ?? 0) > RALLY_KEEP_MS) this.entries.delete(id);
    }
    const entries = [...this.entries.values()].sort((a, b) => b.lastAliveAt - a.lastAliveAt).slice(0, MAX_ENTRIES);
    const data: FileShape = { v: 1, savedAt: now, alive, entries };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      this.lastWriteAt = now;
    } catch (err) {
      console.error(`[rts-agents] could not save rally roster to ${this.file}:`, err);
    }
  }

  /**
   * Sessions to offer for reopening: every one cut off by the last stop (whenever that was), plus
   * any that closed within RALLY_WINDOW_MS before the cut (or before now when nothing was cut).
   * Sessions running right now are never offered.
   */
  getState(now: number = Date.now()): RallyResponse {
    const running = new Set(this.agents().filter((a) => a.alive).map((a) => a.sessionId));
    let cutAt: number | null = null;
    for (const e of this.entries.values()) {
      if (e.cutAt !== null && !running.has(e.sessionId)) cutAt = Math.max(cutAt ?? 0, e.cutAt);
    }
    // Recent = closed within the window before now, or before the cut (an outage can outlast the window).
    const recent = (t: number): boolean =>
      t >= now - RALLY_WINDOW_MS || (cutAt !== null && t >= cutAt - RALLY_WINDOW_MS);
    const sessions: RallySession[] = [];
    for (const e of this.entries.values()) {
      if (running.has(e.sessionId) || !e.logged) continue;
      const openAtCut = e.cutAt !== null;
      if (!openAtCut && !recent(e.lastAliveAt)) continue;
      sessions.push({
        sessionId: e.sessionId,
        shortId: e.sessionId.slice(0, 8),
        name: e.name,
        title: e.title,
        cwd: e.cwd,
        rootCwd: e.rootCwd,
        installDir: e.installDir,
        isSquire: e.isSquire,
        lastAliveAt: e.lastAliveAt,
        openAtCut,
      });
    }
    sessions.sort((a, b) => Number(b.openAtCut) - Number(a.openAtCut) || b.lastAliveAt - a.lastAliveAt);
    return { cutAt, windowMs: RALLY_WINDOW_MS, sessions, serverTime: now };
  }
}
