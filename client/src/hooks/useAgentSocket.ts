// WebSocket client per PROTOCOL.md: receives snapshot/agents/event/meta/rewards/
// shutdown, reconnects with exponential backoff (1s → 30s cap, ±20% jitter).

import { useEffect, useState } from 'react';
import type {
  ActivityEvent,
  AgentState,
  ConnectionStatus,
  JournalEntry,
  RewardsState,
  ServerMessage,
} from '../types/agent';

const MAX_EVENTS = 50;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

/** The most recent award with a nonce, so toasts fire exactly once per message. */
export interface LastAward {
  award: JournalEntry;
  nonce: number;
}

export interface AgentSocket {
  agents: AgentState[];
  events: ActivityEvent[];
  claudeDirs: string[];
  connection: ConnectionStatus;
  /** serverTime − client Date.now() from the latest snapshot. Add to Date.now()
   *  when comparing against server-stamped timestamps (LAN devices may drift). */
  skewMs: number;
  /** Null until the first snapshot (or on servers without rewards). */
  rewards: RewardsState | null;
  lastAward: LastAward | null;
  /** A snapshot has arrived at least once, so `agents` is the real roster (not the empty start). */
  synced: boolean;
}

function isRewardsState(v: unknown): v is RewardsState {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<RewardsState>;
  return Array.isArray(r.catalog) && Array.isArray(r.inventory) && Array.isArray(r.journal);
}

/** The server's http(s) origin, no trailing slash (REST calls; the socket swaps the scheme). */
export function serverHttpUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL;
  const base =
    typeof fromEnv === 'string' && fromEnv.length > 0
      ? fromEnv
      : `http://${location.hostname}:4444`;
  return base.replace(/^ws/, 'http').replace(/\/+$/, '');
}

function serverWsUrl(): string {
  // http → ws, https → wss.
  return `${serverHttpUrl().replace(/^http/, 'ws')}/ws`;
}

export function useAgentSocket(): AgentSocket {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [claudeDirs, setClaudeDirs] = useState<string[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [skewMs, setSkewMs] = useState(0);
  const [rewards, setRewards] = useState<RewardsState | null>(null);
  const [lastAward, setLastAward] = useState<LastAward | null>(null);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let sawShutdown = false;

    const scheduleReconnect = (): void => {
      if (disposed) return;
      const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      const jittered = exp * (0.8 + Math.random() * 0.4); // ±20%
      attempt += 1;
      timer = window.setTimeout(connect, jittered);
    };

    const handleMessage = (raw: unknown): void => {
      if (typeof raw !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed frame — ignore
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      // The cast is narrowed per-variant below: each case re-checks the payload
      // shape it needs and ignores the frame otherwise (same path as malformed).
      const msg = parsed as ServerMessage;
      switch (msg.type) {
        case 'snapshot':
          if (
            !Array.isArray(msg.agents) ||
            !Array.isArray(msg.events) ||
            !Array.isArray(msg.claudeDirs)
          ) {
            break;
          }
          // A delivered snapshot proves the connection is healthy — only now
          // reset the backoff (an accept-then-drop server would otherwise be
          // hammered at ~1 Hz forever).
          attempt = 0;
          setAgents(msg.agents);
          setSynced(true);
          setEvents(msg.events.slice(-MAX_EVENTS));
          setClaudeDirs(msg.claudeDirs);
          if (typeof msg.serverTime === 'number') setSkewMs(msg.serverTime - Date.now());
          if (isRewardsState(msg.rewards)) setRewards(msg.rewards);
          break;
        case 'rewards': {
          if (!isRewardsState(msg.rewards)) break;
          setRewards(msg.rewards);
          const award = msg.award;
          if (typeof award === 'object' && award !== null && typeof award.id === 'string') {
            setLastAward((prev) => ({ award, nonce: (prev?.nonce ?? 0) + 1 }));
          }
          break;
        }
        case 'agents':
          if (!Array.isArray(msg.agents)) break;
          setAgents(msg.agents);
          break;
        case 'event': {
          const event = msg.event;
          if (typeof event !== 'object' || event === null) break;
          setEvents((prev) => {
            const next = prev.length >= MAX_EVENTS ? prev.slice(prev.length - MAX_EVENTS + 1) : prev.slice();
            next.push(event);
            return next;
          });
          break;
        }
        case 'meta':
          if (!Array.isArray(msg.claudeDirs)) break;
          setClaudeDirs(msg.claudeDirs);
          break;
        case 'shutdown':
          sawShutdown = true;
          setConnection('server-shutdown');
          break;
        default:
          break; // unknown message types must never throw
      }
    };

    const connect = (): void => {
      if (disposed) return;
      sawShutdown = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(serverWsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;

      socket.onopen = () => {
        if (disposed) return;
        // Backoff resets on the first snapshot, not here: an open alone does
        // not prove the server can actually serve us.
        setConnection('online');
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (!disposed) handleMessage(ev.data);
      };
      socket.onerror = () => {
        // onclose always follows — reconnect is scheduled there.
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection(sawShutdown ? 'server-shutdown' : 'offline');
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // closing a CONNECTING socket can throw in some browsers — ignore
        }
      }
    };
  }, []);

  return { agents, events, claudeDirs, connection, skewMs, rewards, lastAward, synced };
}
