// Party Leader review verdicts: the Leader session POSTs one per review (approved / changes /
// needs-you, with a short note), the client shows it on the worker's party card. Persisted to
// ~/.rts-agents/reviews.json so a restart keeps the last verdicts.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReviewVerdict, ReviewsResponse } from './types';

const FILE = path.join(os.homedir(), '.rts-agents', 'reviews.json');
/** Shared secret the Leader sends with each verdict (X-RTS-Token); 0600, so web pages can't read it. */
export const TOKEN_FILE = path.join(os.homedir(), '.rts-agents', 'review-token');

/** The review token, created on first use. */
export function reviewToken(): string {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  } catch {
    // not there yet
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
const MAX = 60;
const VERDICTS = new Set(['approved', 'changes', 'needs-you']);

export class Reviews {
  private byId = new Map<string, ReviewVerdict>();

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { verdicts?: unknown };
      if (Array.isArray(raw.verdicts)) {
        for (const v of raw.verdicts) {
          const ok = Reviews.parse(v);
          if (ok) this.byId.set(ok.sessionId, ok);
        }
      }
    } catch {
      // first run / unreadable — start empty
    }
  }

  /** Validate an untrusted body; null when it isn't a verdict. */
  static parse(v: unknown): ReviewVerdict | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const sessionId = typeof o['sessionId'] === 'string' ? o['sessionId'] : '';
    const verdict = typeof o['verdict'] === 'string' ? o['verdict'] : '';
    if (!/^[\w-]{8,64}$/.test(sessionId) || !VERDICTS.has(verdict)) return null;
    const note = typeof o['note'] === 'string' ? o['note'].replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 400) : '';
    const round = Number.isInteger(o['round']) && (o['round'] as number) >= 0 ? (o['round'] as number) : 0;
    const at = typeof o['at'] === 'number' ? o['at'] : Date.now();
    const turnDoneAt = typeof o['turnDoneAt'] === 'number' ? o['turnDoneAt'] : undefined;
    const replies = Array.isArray(o['replies'])
      ? (o['replies'] as unknown[])
          .filter((r): r is string => typeof r === 'string')
          .map((r) => r.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    return { sessionId, verdict: verdict as ReviewVerdict['verdict'], note, round, ...(replies.length ? { replies } : {}), at, ...(turnDoneAt !== undefined ? { turnDoneAt } : {}) };
  }

  /** `turnDoneAt` comes from the server's own agent state, never from the request body. */
  record(raw: unknown, turnDoneAt: number | null = null): ReviewVerdict | null {
    const v = Reviews.parse(raw);
    if (!v) return null;
    const { turnDoneAt: _ignored, ...rest } = v;
    const stamped: ReviewVerdict = { ...rest, at: Date.now(), ...(turnDoneAt !== null ? { turnDoneAt } : {}) };
    this.byId.delete(v.sessionId); // re-insert so Map order = recency
    this.byId.set(v.sessionId, stamped);
    // Keep memory at the same cap as the file: drop the oldest.
    while (this.byId.size > MAX) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    this.save();
    return stamped;
  }

  getState(): ReviewsResponse {
    return { verdicts: [...this.byId.values()].sort((a, b) => b.at - a.at) };
  }

  private save(): void {
    const verdicts = this.getState().verdicts.slice(0, MAX);
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify({ v: 1, verdicts }));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (err) {
      console.error('[rts-agents] could not save reviews:', err instanceof Error ? err.message : err);
    }
  }
}
