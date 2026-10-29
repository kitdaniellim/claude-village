// Activity dock state: open (full panel) / collapsed (header strip) / closed
// (hidden, restore from the top bar). Remembered in localStorage.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent } from '../types/agent';

export type FeedMode = 'open' | 'collapsed' | 'closed';
const MAX_SEEN_EVENTS = 400;

export const FEED_STORAGE_KEY = 'rts-agents.feed.v1';

export interface FeedDock {
  mode: FeedMode;
  setMode: (mode: FeedMode) => void;
  /** Keyboard "A": open ↔ collapsed; a closed dock reopens. */
  toggle: () => void;
}

function isFeedMode(v: unknown): v is FeedMode {
  return v === 'open' || v === 'collapsed' || v === 'closed';
}

function loadMode(): FeedMode {
  try {
    const raw = localStorage.getItem(FEED_STORAGE_KEY);
    if (!raw) return 'open';
    const parsed: unknown = JSON.parse(raw);
    const mode = typeof parsed === 'object' && parsed !== null ? (parsed as { mode?: unknown }).mode : undefined;
    return isFeedMode(mode) ? mode : 'open';
  } catch {
    return 'open';
  }
}

function saveMode(mode: FeedMode): void {
  try {
    localStorage.setItem(FEED_STORAGE_KEY, JSON.stringify({ mode }));
  } catch {
    // storage unavailable — the dock state lives for this page load only
  }
}

export function useFeedDock(): FeedDock {
  const [mode, setModeState] = useState<FeedMode>(loadMode);

  const setMode = useCallback((next: FeedMode) => {
    setModeState(next);
    saveMode(next);
  }, []);

  const toggle = useCallback(() => {
    setModeState((cur) => {
      const next: FeedMode = cur === 'open' ? 'collapsed' : 'open';
      saveMode(next);
      return next;
    });
  }, []);

  return { mode, setMode, toggle };
}

/** Events that arrived while the dock was not open; resets to 0 when it opens.
 *  The first non-empty snapshot is history, not news, so it is never counted. */
export function useUnreadEvents(events: ActivityEvent[], active: boolean): number {
  const seen = useRef<Set<string> | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!seen.current) {
      if (events.length === 0) return;
      seen.current = new Set(events.map((e) => e.id));
      return;
    }
    const s = seen.current;
    let fresh = 0;
    for (const e of events) {
      if (s.has(e.id)) continue;
      s.add(e.id);
      fresh += 1;
    }
    if (s.size > MAX_SEEN_EVENTS) seen.current = new Set(events.map((e) => e.id));
    if (!active && fresh > 0) setUnread((n) => n + fresh);
  }, [events, active]);

  useEffect(() => {
    if (active) setUnread(0);
  }, [active]);

  return active ? 0 : unread;
}
