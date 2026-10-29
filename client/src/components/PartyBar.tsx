// Left "Party" panel: one card per agent (active first), a filter box, and
// click → select the session (village focus pulse + terminal drawer).

import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { AgentState, AgentStatus } from '../types/agent';
import { STATUS_COLORS, heroColor } from '../utils/spriteMapper';
import { flavorLine } from '../utils/flavor';
import { agentBranch, agentName, agentPlaceLabel } from '../utils/agentLabel';
import './PartyBar.css';

interface PartyBarProps {
  agents: AgentState[];
  /** Server-clock skew (serverTime − Date.now()) — keeps relTime honest on
   *  LAN devices whose clock drifts from the server's. */
  skewMs: number;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  /** The "/" shortcut focuses this input. */
  filterRef?: RefObject<HTMLInputElement | null>;
}

const STATUS_RANK: Record<AgentStatus, number> = {
  running: 0,
  thinking: 0,
  error: 1,
  done: 2,
  idle: 3,
};

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface CardModel {
  agent: AgentState;
  name: string;
  place: string;
  branch: string | null;
  haystack: string;
}

export default function PartyBar({ agents, skewMs, selectedSessionId, onSelect, filterRef }: PartyBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const cards = useMemo<CardModel[]>(() => {
    const sorted = [...agents].sort((a, b) => {
      const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (r !== 0) return r;
      return b.lastEventAt - a.lastEventAt;
    });
    return sorted.map((agent) => {
      const name = agentName(agent);
      const place = agentPlaceLabel(agent);
      const branch = agentBranch(agent);
      const haystack = [name, agent.title, agent.customTitle, agent.project, place, agent.shortId, branch]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return { agent, name, place, branch, haystack };
    });
  }, [agents]);

  const q = filter.trim().toLowerCase();
  const visible = q ? cards.filter((c) => c.haystack.includes(q)) : cards;

  const onFilterKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setFilter('');
      e.currentTarget.blur();
    }
  };

  return (
    <aside className="party">
      <div className="party-header">
        <span className="party-title">Party</span>
        <span className="party-count">{agents.length}</span>
        <input
          ref={filterRef}
          className="party-filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKey}
          placeholder="Filter  /"
          aria-label="Filter party by title, project or place"
          spellCheck={false}
        />
      </div>
      <div className="party-list">
        {agents.length === 0 && (
          <div className="party-empty">
            No heroes yet.
            <br />
            Start a Claude Code session.
          </div>
        )}
        {agents.length > 0 && visible.length === 0 && (
          <div className="party-empty">No hero matches “{filter.trim()}”.</div>
        )}
        {visible.map(({ agent: a, name, place, branch }) => {
          const color = heroColor(a.sessionId);
          const detail = [a.tool, a.detail].filter(Boolean).join(' · ');
          const selected = a.sessionId === selectedSessionId;
          return (
            <button
              key={a.sessionId}
              type="button"
              className={`party-card ${selected ? 'party-card-selected' : ''}`}
              aria-pressed={selected}
              onClick={() => onSelect(a.sessionId)}
              title={`${name} — open terminal & focus ${a.shortId} in the village`}
            >
              <span className="party-avatar" style={{ background: color }}>
                <span className="party-avatar-face" />
              </span>
              <span className="party-body">
                <span className="party-head">
                  <span className="party-name">{name}</span>
                  {a.status === 'done' && <span className="party-badge">Your turn</span>}
                </span>
                <span className="party-sub">
                  <span className="party-shortid" style={{ color }}>
                    {a.shortId}
                  </span>
                  <span className="party-sep">·</span>
                  <span className="party-place">{place}</span>
                  {branch && (
                    <>
                      <span className="party-sep">·</span>
                      <span className="party-branch" title={`branch ${branch}`}>
                        ⎇ {branch}
                      </span>
                    </>
                  )}
                </span>
                <span className="party-flavor">{flavorLine(a)}</span>
                <span className="party-detail" title={detail || undefined}>
                  {detail || '—'}
                </span>
                <span className="party-foot">
                  <span className={`party-pill party-pill-${a.status}`}>
                    <span className="party-dot" style={{ background: STATUS_COLORS[a.status] }} />
                    {a.status}
                  </span>
                  <span className="party-when">{relTime(a.lastEventAt, now + skewMs)}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
