// Bottom panel: the last 50 activity events, newest at the bottom, pinned
// auto-scroll with a "jump to latest" chip when the user scrolls up.

import { useEffect, useRef, useState } from 'react';
import type { UIEvent as ReactUIEvent } from 'react';
import type { ActivityEvent, ActivityKind } from '../types/agent';
import { heroColor } from '../utils/spriteMapper';
import './ActivityFeed.css';

interface ActivityFeedProps {
  events: ActivityEvent[];
}

const KIND_META: Record<ActivityKind, { verb: string; color: string }> = {
  tool_start: { verb: '->', color: '#60a5fa' },
  tool_done: { verb: 'ok', color: '#4ade80' },
  tool_error: { verb: 'ERR', color: '#f87171' },
  thinking: { verb: '...', color: '#a78bfa' },
  turn_done: { verb: 'done', color: '#4ade80' },
  session_new: { verb: '+', color: '#facc15' },
  session_idle: { verb: 'zzz', color: '#9ca3af' },
  session_removed: { verb: '-', color: '#9ca3af' },
};

function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function ActivityFeed({ events }: ActivityFeedProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  const onScroll = (e: ReactUIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  };

  const jumpToLatest = (): void => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  return (
    <section className="feed">
      <div className="feed-header">
        <span className="feed-title">Activity</span>
        <span className="feed-hint">last {events.length} events</span>
      </div>
      <div className="feed-scroll" ref={listRef} onScroll={onScroll}>
        {events.length === 0 ? (
          <div className="feed-empty">Awaiting tales from the village…</div>
        ) : (
          events.map((ev) => {
            const meta = KIND_META[ev.kind];
            const color = heroColor(ev.sessionId);
            return (
              <div key={ev.id} className="feed-line">
                <span className="feed-time">{clock(ev.ts)}</span>
                <span
                  className="feed-chip"
                  style={{ color, borderColor: color }}
                >
                  {ev.shortId}
                </span>
                <span className="feed-verb" style={{ color: meta.color }}>
                  {meta.verb}
                </span>
                {ev.tool && <span className="feed-tool">{ev.tool}</span>}
                {ev.detail && <span className="feed-detail">{ev.detail}</span>}
              </div>
            );
          })
        )}
      </div>
      {!pinned && (
        <button type="button" className="feed-jump" onClick={jumpToLatest}>
          ▼ jump to latest
        </button>
      )}
    </section>
  );
}
