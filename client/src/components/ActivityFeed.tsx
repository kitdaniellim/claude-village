// Bottom dock: the last 50 activity events, newest at the bottom, pinned
// auto-scroll with a "jump to latest" chip. Collapses to a one-line strip
// (latest event + unread count) or closes entirely; "A" toggles it.

import { useEffect, useRef, useState } from 'react';
import type { UIEvent as ReactUIEvent } from 'react';
import type { ActivityEvent, ActivityKind } from '../types/agent';
import type { FeedMode } from '../hooks/useFeedDock';
import { heroColor } from '../utils/spriteMapper';
import { PixelIcon } from './PixelIcon';
import './ActivityFeed.css';

interface ActivityFeedProps {
  events: ActivityEvent[];
  mode: FeedMode;
  /** Events that arrived while collapsed — shown as a badge on the strip. */
  unread: number;
  onMode: (mode: FeedMode) => void;
}

const KIND_META: Record<ActivityKind, { verb: string; color: string }> = {
  tool_start: { verb: '->', color: 'var(--status-running)' },
  tool_done: { verb: 'ok', color: 'var(--status-done)' },
  tool_error: { verb: 'ERR', color: 'var(--status-error)' },
  thinking: { verb: '...', color: 'var(--status-thinking)' },
  turn_done: { verb: 'done', color: 'var(--status-done)' },
  session_new: { verb: '+', color: '#facc15' },
  session_idle: { verb: 'zzz', color: 'var(--status-idle)' },
  session_removed: { verb: '-', color: 'var(--status-idle)' },
};

function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function FeedLine({ ev }: { ev: ActivityEvent }) {
  const meta = KIND_META[ev.kind];
  const color = heroColor(ev.sessionId);
  return (
    <div className="feed-line">
      <span className="feed-time">{clock(ev.ts)}</span>
      <span className="feed-chip" style={{ color, borderColor: color }}>
        {ev.shortId}
      </span>
      <span className="feed-verb" style={{ color: meta.color }}>
        {meta.verb}
      </span>
      {ev.tool && <span className="feed-tool">{ev.tool}</span>}
      {ev.detail && <span className="feed-detail">{ev.detail}</span>}
    </div>
  );
}

export default function ActivityFeed({ events, mode, unread, onMode }: ActivityFeedProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const open = mode === 'open';

  // Stay glued to the newest line, including right after the dock re-expands.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [events, open]);

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

  if (mode === 'closed') return null;

  const latest = events[events.length - 1];

  return (
    <section className={`feed feed-${mode}`} aria-label="Activity">
      <div className="feed-head ui-head">
        <button
          type="button"
          className="feed-toggle"
          onClick={() => onMode(open ? 'collapsed' : 'open')}
          aria-expanded={open}
          title={open ? 'Collapse activity (A)' : 'Expand activity (A)'}
        >
          <PixelIcon name={open ? 'chevron-down' : 'chevron-up'} className="feed-toggle-icon" />
          <span className="ui-title">Activity</span>
        </button>
        <span className="ui-count" title="Events kept in the feed">
          {events.length}
        </span>
        {!open && unread > 0 && (
          <span className="feed-unread" role="status">
            {unread > 99 ? '99+' : unread} new
          </span>
        )}
        {!open && latest && (
          <div className="feed-peek" aria-hidden="true">
            <FeedLine ev={latest} />
          </div>
        )}
        <span className="feed-spacer" />
        <span className="feed-hint">
          <kbd className="ui-kbd">A</kbd>
        </span>
        <button
          type="button"
          className="ui-btn ui-btn-icon feed-btn"
          onClick={() => onMode('closed')}
          title="Hide activity (restore from the top bar)"
          aria-label="Hide activity"
        >
          <PixelIcon name="x" />
        </button>
      </div>

      {open && (
        <div className="feed-scroll" ref={listRef} onScroll={onScroll}>
          {events.length === 0 ? (
            <div className="feed-empty">Awaiting tales from the village…</div>
          ) : (
            events.map((ev) => <FeedLine key={ev.id} ev={ev} />)
          )}
        </div>
      )}

      {open && !pinned && (
        <button type="button" className="ui-btn ui-btn-primary feed-jump" onClick={jumpToLatest}>
          <PixelIcon name="chevron-down" /> latest
        </button>
      )}
    </section>
  );
}
