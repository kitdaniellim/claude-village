// The rally roster: sessions a power cut / restart killed, plus ones closed in the last few
// hours, fetched from GET /api/rally. Refetched on (re)connect and whenever the set of running
// sessions changes (a rallied hero coming back drops off the list). Dismissals are remembered.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentState, ConnectionStatus, RallyResponse, RallySession } from '../types/agent';
import { serverHttpUrl } from './useAgentSocket';
import { usePersistentState } from './usePersistentState';

/** sessionId → the lastAliveAt that was dismissed (it reappears if the session runs and dies again). */
type Dismissed = Record<string, number>;

function isDismissed(v: unknown): v is Dismissed {
  return !!v && typeof v === 'object' && Object.values(v as object).every((n) => typeof n === 'number');
}

function isRallyResponse(v: unknown): v is RallyResponse {
  return !!v && typeof v === 'object' && Array.isArray((v as RallyResponse).sessions);
}

export interface Rally {
  cutAt: number | null;
  windowMs: number;
  /** Not running, not dismissed; openAtCut first. */
  sessions: RallySession[];
  dismiss: (sessions: RallySession[]) => void;
  refresh: () => void;
}

export function useRally(agents: AgentState[], connection: ConnectionStatus): Rally {
  const [data, setData] = useState<RallyResponse | null>(null);
  const [nonce, setNonce] = useState(0);
  const [dismissed, setDismissed] = usePersistentState<Dismissed>('rally-dismissed', {}, isDismissed);

  // Only the running set matters — agents re-render many times a second.
  const aliveKey = useMemo(
    () =>
      agents
        .filter((a) => a.alive)
        .map((a) => a.sessionId)
        .sort()
        .join('|'),
    [agents],
  );

  useEffect(() => {
    if (connection !== 'online') return;
    const ctl = new AbortController();
    // Debounced: a rally starts several sessions within a few seconds.
    const t = window.setTimeout(() => {
      fetch(`${serverHttpUrl()}/api/rally`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => {
          if (isRallyResponse(j)) setData(j);
        })
        .catch(() => undefined); // older server without /api/rally, or offline — keep what we have
    }, 800);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [connection, aliveKey, nonce]);

  const running = useMemo(() => new Set(aliveKey.split('|')), [aliveKey]);
  const sessions = useMemo(
    () =>
      (data?.sessions ?? []).filter(
        (s) => !running.has(s.sessionId) && dismissed[s.sessionId] !== s.lastAliveAt,
      ),
    [data, running, dismissed],
  );

  const dismiss = useCallback(
    (list: RallySession[]) => {
      setDismissed((cur) => {
        // Keep only entries the server still offers, so the map never grows without bound.
        const offered = new Set((data?.sessions ?? []).map((s) => s.sessionId));
        const next: Dismissed = {};
        for (const [id, at] of Object.entries(cur)) if (offered.has(id)) next[id] = at;
        for (const s of list) next[s.sessionId] = s.lastAliveAt;
        return next;
      });
    },
    [data, setDismissed],
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { cutAt: data?.cutAt ?? null, windowMs: data?.windowMs ?? 0, sessions, dismiss, refresh };
}
