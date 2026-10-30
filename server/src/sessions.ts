// LiveSessions — reads `<claudeDir>/sessions/<pid>.json`, which Claude Code
// writes for every running process (pid, sessionId, cwd, /rename name, its own
// busy/idle status). This is the authoritative "what is running" list; the logs
// only tell us what a session is doing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LIVE_POLL_INTERVAL_MS } from './types';
import { tempDirs } from './watcher';

export interface LiveSession {
  pid: number;
  sessionId: string;
  installDir: string;
  cwd: string | null;
  /** Session name; `nameSource === 'user'` means it came from /rename. */
  name: string | null;
  nameSource: string | null;
  status: 'busy' | 'idle' | 'shell' | null;
  startedAt: number | null;
  updatedAt: number | null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Is the pid still running? Unknown errors (EPERM, unsupported) count as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== 'ESRCH';
  }
}

function parseSessionFile(file: string, installDir: string): LiveSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null; // being written — next poll gets it
  }
  if (o === null || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const pid = asNum(r['pid']);
  const sessionId = asStr(r['sessionId']);
  if (pid === null || sessionId === null) return null;
  // Headless helpers (e.g. the remember plugin's `claude -p` summariser, run from %TEMP%)
  // are not sessions the user drives — keep them off the map.
  const kind = asStr(r['kind']);
  if (kind !== null && kind !== 'interactive') return null;
  const cwd = asStr(r['cwd']);
  // Also any sub-folder of %TEMP% (the summariser runs from %TEMP%\remember-summarizer-cwd-*).
  if (cwd) {
    const c = path.resolve(cwd).toLowerCase();
    for (const t of tempDirs()) {
      const tmp = path.resolve(t).toLowerCase();
      if (c === tmp || c.startsWith(tmp + path.sep)) return null;
    }
  }
  const status = asStr(r['status']);
  return {
    pid,
    sessionId,
    installDir,
    cwd: asStr(r['cwd']),
    name: asStr(r['name']),
    nameSource: asStr(r['nameSource']),
    status: status === 'busy' || status === 'idle' || status === 'shell' ? status : null,
    startedAt: asNum(r['startedAt']),
    updatedAt: asNum(r['updatedAt']),
  };
}

export class LiveSessions {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey = '';

  constructor(
    private readonly claudeDirs: () => string[],
    private readonly onChange: (sessions: LiveSession[]) => void
  ) {}

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), LIVE_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read every session file; one entry per sessionId (latest `updatedAt` wins). */
  scan(): LiveSession[] {
    const bySession = new Map<string, LiveSession>();
    for (const dir of this.claudeDirs()) {
      const sessionsDir = path.join(dir, 'sessions');
      let names: string[];
      try {
        names = fs.readdirSync(sessionsDir);
      } catch {
        continue; // no sessions dir in this install
      }
      for (const name of names) {
        if (!/^\d+\.json$/.test(name)) continue; // skip .key files and .rtbak leftovers
        const s = parseSessionFile(path.join(sessionsDir, name), path.basename(dir));
        if (!s || !pidAlive(s.pid)) continue;
        const prev = bySession.get(s.sessionId);
        if (!prev || (s.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) bySession.set(s.sessionId, s);
      }
    }
    return [...bySession.values()].sort((a, b) => a.pid - b.pid);
  }

  private poll(): void {
    const sessions = this.scan();
    // Only notify on change — the store would otherwise broadcast every 3 s.
    const key = sessions.map((s) => `${s.pid}:${s.sessionId}:${s.status}:${s.name}:${s.cwd}`).join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      this.onChange(sessions);
    } catch (err) {
      console.error('[rts-agents] live-session listener failed:', err);
    }
  }
}
