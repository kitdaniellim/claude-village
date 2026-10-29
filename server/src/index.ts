// RTS Agents server entry — env loading, Bun.serve (REST + WebSocket),
// broadcast throttling, LAN URLs, graceful shutdown. See PROTOCOL.md.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerWebSocket } from 'bun';
import type { AgentsResponse, ServerMessage } from './types';
import { BROADCAST_THROTTLE_MS } from './types';
import { AgentStore } from './state';
import { Watcher } from './watcher';

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
watcher.start(); // synchronous initial scan → banner counts below are real

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
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: LAN ? '0.0.0.0' : 'localhost',
  fetch(req, srv): Response | undefined {
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
      };
      return new Response(JSON.stringify(body), {
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

store.subscribe((agentsChanged, event) => {
  if (event) publish({ type: 'event', event });
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
  watcher.stop();
  store.stop();
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
    `${store.getAgents().length} active session(s)`
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
