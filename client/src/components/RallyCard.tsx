// "Rally the party": after a power cut (or any restart that killed sessions) this card lists the
// heroes that were out and reopens them all as drawer terminals in one click. Without a cut it
// offers sessions closed in the last few hours. "Choose" opens a checklist; × dismisses them.

import { useEffect, useMemo, useState } from 'react';
import type { RallySession } from '../types/agent';
import type { Rally } from '../hooks/useRally';
import { NAMELESS, agentPlaceLabel } from '../utils/agentLabel';
import { heroColor } from '../utils/spriteMapper';
import { Portrait } from './Portrait';
import './RallyCard.css';

interface RallyCardProps {
  rally: Rally;
  onRally: (sessions: RallySession[]) => void;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function rallyName(s: RallySession): string {
  return s.name?.trim() || NAMELESS;
}

/** Default pick: the ones the cut killed; with no cut, everything recent. */
function defaultPick(sessions: RallySession[]): Set<string> {
  const cut = sessions.filter((s) => s.openAtCut);
  return new Set((cut.length > 0 ? cut : sessions).map((s) => s.sessionId));
}

export default function RallyCard({ rally, onRally }: RallyCardProps) {
  const { sessions, cutAt, windowMs } = rally;
  const [open, setOpen] = useState(false);
  const idsKey = sessions.map((s) => s.sessionId).join('|');
  const [picked, setPicked] = useState<Set<string>>(() => defaultPick(sessions));
  // A new roster (a hero came back, a new cut) resets the pick to the defaults.
  useEffect(() => setPicked(defaultPick(sessions)), [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => sessions.filter((s) => picked.has(s.sessionId)), [sessions, picked]);
  if (sessions.length === 0) return null;

  const cutCount = sessions.filter((s) => s.openAtCut).length;
  const outage = cutAt !== null && cutCount > 0;
  const hours = Math.round(windowMs / 3_600_000);

  const toggle = (id: string): void =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className={`rally ${outage ? 'rally-outage' : ''}`} aria-label="Reopen recent sessions">
      <div className="rally-head">
        <span className="rally-glyph" aria-hidden="true">
          {outage ? '⚡' : '↻'}
        </span>
        <span className="rally-title">
          {outage ? (
            <>
              Village went dark · {clock(cutAt)}
              <span className="rally-sub">
                {cutCount} {cutCount === 1 ? 'hero was' : 'heroes were'} out
              </span>
            </>
          ) : (
            <>
              Recently closed
              <span className="rally-sub">last {hours} h</span>
            </>
          )}
        </span>
        <button
          type="button"
          className="rally-x"
          aria-label="Dismiss"
          title="Dismiss these (they come back if they run and close again)"
          onClick={() => rally.dismiss(sessions)}
        >
          ×
        </button>
      </div>

      <div className="rally-actions">
        <button
          type="button"
          className={`ui-btn ${outage ? 'ui-btn-primary' : ''} rally-go`}
          disabled={chosen.length === 0}
          onClick={() => onRally(chosen)}
          title="Resume each session in its own terminal tab, one after another"
        >
          ↻ Rally {chosen.length === sessions.length && chosen.length > 1 ? 'all ' : ''}
          {chosen.length}
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-ghost rally-choose"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▾' : '▸'} Choose
        </button>
      </div>

      {open && (
        <ul className="rally-list">
          {sessions.map((s) => {
            const name = rallyName(s);
            const place = agentPlaceLabel({ cwd: s.cwd, rootCwd: s.rootCwd, title: s.title, customTitle: s.name });
            return (
              <li key={s.sessionId}>
                <label className="rally-row" title={[name, s.title, s.shortId, s.rootCwd ?? s.cwd].filter(Boolean).join(' · ')}>
                  <input type="checkbox" checked={picked.has(s.sessionId)} onChange={() => toggle(s.sessionId)} />
                  <Portrait sessionId={s.sessionId} color={heroColor(s.sessionId)} squire={s.isSquire} className="rally-face" />
                  <span className="rally-who">
                    <span className="rally-name">
                      {name}
                      {!s.name?.trim() && s.title && <span className="rally-hint"> · {s.title}</span>}
                    </span>
                    <span className="rally-meta">
                      {place} · {s.openAtCut ? 'out at the cut' : `closed ${clock(s.lastAliveAt)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
