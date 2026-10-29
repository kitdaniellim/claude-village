// SquireScanner — watches each session's sub-agent transcripts
// (`<projects>/<slug>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json`).
// A squire is active while its file keeps growing or its last assistant line
// hasn't reached `end_turn`; the store turns that into the `delegating` status.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SquireInfo } from './types';
import { SQUIRE_FRESH_MS, SQUIRE_POLL_INTERVAL_MS, SQUIRE_STALE_MS } from './types';
import type { AgentStore } from './state';

const TAIL_BYTES = 4096;

function readMetaDescription(file: string): string | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as { description?: unknown };
    return typeof o.description === 'string' && o.description ? o.description : null;
  } catch {
    return null;
  }
}

/** Last `stop_reason` in the file's tail; null when none found. */
function lastStopReason(file: string, size: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const matches = text.match(/"stop_reason":\s*"([a-z_]+)"/g);
    if (!matches || matches.length === 0) return null;
    const last = matches[matches.length - 1] as string;
    return /"([a-z_]+)"$/.exec(last)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export class SquireScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly descriptions = new Map<string, string | null>();
  private readonly lastKey = new Map<string, string>();

  constructor(
    private readonly store: AgentStore,
    private readonly sessionPath: (sessionId: string) => string | null
  ) {}

  start(): void {
    this.scanAll();
    this.timer = setInterval(() => this.scanAll(), SQUIRE_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Scan every session the store knows; only alive or recently active ones are worth the I/O. */
  scanAll(now: number = Date.now()): void {
    for (const agent of this.store.getAgents()) {
      if (!agent.alive && now - agent.lastEventAt > SQUIRE_STALE_MS) continue;
      const file = this.sessionPath(agent.sessionId);
      if (!file) continue;
      const squires = this.scanSession(file, now);
      // Only push changes — the store would otherwise broadcast every poll.
      const key = squires.map((s) => `${s.id}:${s.active ? 1 : 0}`).join('|');
      if (this.lastKey.get(agent.sessionId) === key) continue;
      this.lastKey.set(agent.sessionId, key);
      this.store.applySquires(agent.sessionId, squires, now);
    }
  }

  scanSession(sessionFile: string, now: number): SquireInfo[] {
    const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return []; // no sub-agents ever spawned
    }
    const out: SquireInfo[] = [];
    for (const name of names) {
      const m = /^agent-([a-z0-9]+)\.jsonl$/.exec(name);
      if (!m) continue;
      const id = m[1] as string;
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const age = now - st.mtimeMs;
      if (age > SQUIRE_STALE_MS) continue; // old squire — not worth showing
      let description = this.descriptions.get(file);
      if (description === undefined) {
        description = readMetaDescription(path.join(dir, `agent-${id}.meta.json`));
        this.descriptions.set(file, description);
      }
      const active = age <= SQUIRE_FRESH_MS || lastStopReason(file, st.size) !== 'end_turn';
      out.push({ id, description, active, lastActiveAt: st.mtimeMs });
    }
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
}
