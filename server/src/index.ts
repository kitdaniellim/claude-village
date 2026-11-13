// RTS Agents server entry — env loading, Bun.serve (REST + WebSocket),
// broadcast throttling, LAN URLs, graceful shutdown. See PROTOCOL.md.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerWebSocket } from 'bun';
import type { AgentsResponse, NamesResponse, ServerMessage } from './types';
import { BROADCAST_THROTTLE_MS } from './types';
import { AgentStore } from './state';
import { Watcher } from './watcher';
import { LiveSessions } from './sessions';
import { Rewards } from './rewards';
import { Reviews, reviewToken } from './reviews';
import { SquireScanner } from './squires';
import { Rally } from './rally';

// ── env ──────────────────────────────────────────────────────────────────────

/** Minimal KEY=VALUE .env parser (Bun auto-loads cwd .env; this also covers
 *  running from the repo root where server/.env is not the cwd). */
function loadDotEnv(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    const existing = process.env[key];
    if (existing === undefined || existing === '') process.env[key] = value;
  }
}

loadDotEnv(path.join(import.meta.dir, '..', '.env'));

const portRaw = Number.parseInt(process.env['PORT'] ?? '', 10);
const PORT = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 4444;
const CLIENT_URL = process.env['CLIENT_URL'] || 'http://localhost:4445';
const LAN = process.env['RTS_LAN'] === '1';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': LAN ? '*' : CLIENT_URL,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── state + watcher ──────────────────────────────────────────────────────────

const store = new AgentStore();
const watcher = new Watcher(store);
// Live processes first so the initial scan tails every running session's log, however old.
const live = new LiveSessions(
  () => watcher.getClaudeDirs(),
  (sessions) => {
    watcher.setLiveSessions(sessions.map((s) => s.sessionId));
    store.applyLive(sessions);
  }
);
const rewards = new Rewards();
const reviews = new Reviews();
const REVIEW_TOKEN = reviewToken();
// Reads the last run's roster now, before the first save overwrites it.
const rally = new Rally(() => store.getAgents());

/** `<claudeDir>/projects/<slug>/<sessionId>.jsonl`, wherever it lives (old sessions aren't tracked). */
function findTranscript(sessionId: string): string | null {
  const tracked = watcher.getSessionPath(sessionId);
  if (tracked) return tracked;
  for (const dir of watcher.getClaudeDirs()) {
    const projects = path.join(dir, 'projects');
    let slugs: string[];
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const file = path.join(projects, slug, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}
/** Latest `/rename` (custom-title / agent-name line) in a transcript, or null. */
function lastSessionName(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let name: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"custom-title"') && !line.includes('"agent-name"')) continue;
    try {
      const o = JSON.parse(line) as { type?: unknown; customTitle?: unknown; agentName?: unknown };
      const v = o.type === 'custom-title' ? o.customTitle : o.type === 'agent-name' ? o.agentName : null;
      if (typeof v === 'string' && v.trim()) name = v.trim();
    } catch {
      // partial / foreign line
    }
  }
  return name;
}

const squires = new SquireScanner(store, (id) => watcher.getSessionPath(id));
watcher.start(); // synchronous initial scan → banner counts below are real
live.start();
rally.start(); // after the first live scan, so sessions still running aren't counted as cut off
squires.start();
// Repair old quest-log entries saved without a summary (once per start, off the startup path).
setTimeout(() => rewards.backfill(findTranscript), 2_000);

// ── http + websocket ─────────────────────────────────────────────────────────

const TOPIC = 'rts';
type WS = ServerWebSocket<unknown>;
const sockets = new Set<WS>();

function snapshotMessage(): ServerMessage {
  return {
    type: 'snapshot',
    agents: store.getAgents(),
    events: store.getEvents(),
    claudeDirs: watcher.getClaudeDirs(),
    serverTime: Date.now(),
    rewards: rewards.getState(),
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: LAN ? '0.0.0.0' : 'localhost',
  fetch(req, srv): Response | Promise<Response> | undefined {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      if (srv.upgrade(req)) return undefined;
      return new Response('Expected WebSocket upgrade', { status: 426, headers: CORS_HEADERS });
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200, headers: CORS_HEADERS });
    }
    if (url.pathname === '/api/agents') {
      const body: AgentsResponse = {
        agents: store.getAgents(),
        events: store.getEvents(),
        claudeDirs: watcher.getClaudeDirs(),
        serverTime: Date.now(),
        rewards: rewards.getState(),
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    if (url.pathname === '/api/rally') {
      return new Response(JSON.stringify(rally.getState()), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    if (url.pathname === '/api/names') {
      // Sleeping drawer tabs whose sessions left the roster ask for their names back.
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',')
        .filter((id) => /^[\w-]{8,64}$/.test(id))
        .slice(0, 32);
      const body: NamesResponse = { names: {} };
      for (const id of ids) {
        const file = findTranscript(id);
        body.names[id] = file ? lastSessionName(file) : null;
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    if (url.pathname === '/api/reviews') {
      return new Response(JSON.stringify(reviews.getState()), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      // The Party Leader records a verdict (curl from its session). It must send the token from
      // ~/.rts-agents/review-token as X-RTS-Token — a web page can neither read it nor send a
      // custom header cross-origin without a preflight — and a JSON body; bad bodies get 400.
      const token = req.headers.get('x-rts-token') ?? '';
      const okToken =
        token.length === REVIEW_TOKEN.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(REVIEW_TOKEN));
      if (!okToken || !(req.headers.get('content-type') ?? '').includes('application/json')) {
        return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
      return req
        .json()
        .catch(() => null)
        .then((body) => {
          const saved = reviews.record(body);
          return new Response(JSON.stringify(saved ? { ok: true, verdict: saved } : { ok: false, error: 'bad verdict' }), {
            status: saved ? 200 : 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        });
    }
    if (url.pathname === '/api/rewards') {
      return new Response(JSON.stringify(rewards.getState()), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    return new Response('not found', { status: 404, headers: CORS_HEADERS });
  },
  websocket: {
    open(ws: WS) {
      sockets.add(ws);
      ws.subscribe(TOPIC);
      const sent = ws.send(JSON.stringify(snapshotMessage()));
      if (sent === 0) {
        // Snapshot dropped (socket closed / backpressure limit). The client
        // never re-requests it, so close to trigger its reconnect+fresh snapshot.
        console.warn('[rts-agents] snapshot send dropped — closing socket so the client reconnects');
        try {
          ws.close(1011, 'snapshot delivery failed');
        } catch {
          // socket already gone
        }
      }
    },
    message() {
      // client never sends — ignore
    },
    close(ws: WS) {
      sockets.delete(ws);
    },
  },
});

function publish(message: ServerMessage): void {
  server.publish(TOPIC, JSON.stringify(message));
}

// ── broadcasting ─────────────────────────────────────────────────────────────

let agentsTimer: ReturnType<typeof setTimeout> | null = null;

rewards.onChange((state, award) => publish({ type: 'rewards', rewards: state, award }));

store.subscribe((agentsChanged, event) => {
  if (event) {
    publish({ type: 'event', event });
    rewards.onEvent(event, store.getAgent(event.sessionId));
  }
  if (agentsChanged && agentsTimer === null) {
    // Coalesce full-list broadcasts to at most one per BROADCAST_THROTTLE_MS.
    agentsTimer = setTimeout(() => {
      agentsTimer = null;
      publish({ type: 'agents', agents: store.getAgents() });
    }, BROADCAST_THROTTLE_MS);
  }
});

watcher.onDirsChange((claudeDirs) => {
  publish({ type: 'meta', claudeDirs });
});

// ── shutdown ─────────────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[rts-agents] ${signal} — shutting down`);
  if (agentsTimer !== null) clearTimeout(agentsTimer);
  const bye = JSON.stringify({ type: 'shutdown' } satisfies ServerMessage);
  for (const ws of sockets) {
    try {
      ws.send(bye);
      ws.close(1001, 'server shutting down');
    } catch {
      // socket already gone
    }
  }
  squires.stop();
  rally.stop();
  live.stop();
  watcher.stop();
  store.stop();
  rewards.stop();
  server.stop(true);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── banner ───────────────────────────────────────────────────────────────────

const dirs = watcher.getClaudeDirs();
console.log(`[rts-agents] listening on http://localhost:${PORT} (ws: /ws)`);
console.log(
  `[rts-agents] claude dirs (${dirs.length}): ${dirs.length > 0 ? dirs.join(', ') : '(none found)'}`
);
console.log(
  `[rts-agents] tracking ${watcher.getTrackedFileCount()} session file(s), ` +
    `${store.getAgents().length} active session(s), ` +
    `${store.getAgents().filter((a) => a.alive).length} live process(es)`
);
if (LAN) {
  console.log('[rts-agents] LAN mode — reachable at:');
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        console.log(`  http://${info.address}:${PORT}`);
      }
    }
  }
}
