// Left "Party" panel: one compact card per agent (active first, squires under
// their parent) showing the friendly bits — ids and raw tool detail live in the
// tooltip; the filter still matches them. Click → select (village + drawer).
// "Create Party" at the top opens a fresh Nameless terminal (choose the project from inside Claude).
// Restored terminal tabs whose hero the server does not list yet get a dimmed placeholder card.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { AgentState, AgentStatus, RallySession, SquireInfo } from '../types/agent';
import type { Rally } from '../hooks/useRally';
import RallyCard from './RallyCard';
import MoveCard from './MoveCard';
import type { MoveStatus } from './TerminalPanel';
import type { SleepingHero } from '../utils/terminalTabs';
import { STATUS_COLORS, STATUS_LABELS, heroColor } from '../utils/spriteMapper';
import { flavorLine } from '../utils/flavor';
import {
  activityLine,
  agentBranch,
  agentName,
  agentPlaceLabel,
  agentSubtitle,
  relTime,
  squireParentName,
} from '../utils/agentLabel';
import { epithetOf, heroTitle } from '../utils/epithet';
import { Portrait } from './Portrait';
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
  /** Open the place chooser to launch a fresh session. */
  onCreateParty: () => void;
  /** Heroes with a (restored) terminal tab the server doesn't list yet — shown as placeholder cards. */
  sleepers?: SleepingHero[];
  /** Sessions a power cut / restart killed (and recent closes), offered for one-click reopening. */
  rally?: Rally;
  onRally?: (sessions: RallySession[]) => void;
  /** Outside terminals that "Move into the village" can take over. */
  moveStatus?: MoveStatus | null;
  onMove?: () => void;
  onCancelMove?: () => void;
  onRestartApp?: (() => void) | null;
}

const STATUS_RANK: Record<AgentStatus, number> = {
  running: 0,
  thinking: 0,
  delegating: 0,
  error: 1,
  done: 2,
  idle: 3,
};

/** Sub-agents still working for this hero (older server snapshots omit the field). */
function activeSquires(a: AgentState): SquireInfo[] {
  return (a.squires ?? []).filter((s) => s.active);
}

/** Active-first order, then each squire moved directly under its parent (orphans keep their slot). */
function partyOrder(agents: AgentState[]): { agent: AgentState; nested: boolean }[] {
  const sorted = [...agents].sort((a, b) => {
    // Sessions whose process has exited sink below every live one.
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    return b.lastEventAt - a.lastEventAt;
  });
  const present = new Set(sorted.map((a) => a.sessionId));
  const nested = (a: AgentState): boolean =>
    a.isSquire && a.squireOf !== null && a.squireOf !== a.sessionId && present.has(a.squireOf);
  const children = new Map<string, AgentState[]>();
  for (const a of sorted) {
    if (!nested(a)) continue;
    const list = children.get(a.squireOf as string) ?? [];
    list.push(a);
    children.set(a.squireOf as string, list);
  }
  const out: { agent: AgentState; nested: boolean }[] = [];
  const placed = new Set<string>();
  const place = (a: AgentState): void => {
    if (placed.has(a.sessionId)) return;
    placed.add(a.sessionId);
    out.push({ agent: a, nested: nested(a) });
    for (const s of children.get(a.sessionId) ?? []) place(s);
  };
  for (const a of sorted) if (!nested(a)) place(a);
  for (const a of sorted) place(a); // squire cycles, if the names ever loop
  return out;
}

/** Status pill (dot + label, ✓ when done) — shared with the drawer's session card. */
export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`party-pill party-pill-${status}`} title={status}>
      <span className="party-dot" style={{ background: STATUS_COLORS[status] }} />
      {status === 'done' && <span className="party-pill-check">✓</span>}
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Branches worth a glance on the card; main/master/HEAD go to the tooltip only. */
function featureBranch(branch: string | null): string | null {
  return branch && !/^(main|master|develop|dev)$/i.test(branch) ? branch : null;
}

interface CardModel {
  agent: AgentState;
  name: string;
  /** The AI's auto title, shown small when the hero is Nameless. */
  subtitle: string | null;
  place: string;
  branch: string | null;
  /** Sits under its parent card. */
  nested: boolean;
  /** Squires: the hero they were forked from, if it is in the party. */
  parent: AgentState | null;
  parentName: string | null;
  haystack: string;
}

export default function PartyBar(props: PartyBarProps) {
  const { agents, skewMs, selectedSessionId, onSelect, filterRef, onCreateParty, sleepers = [], rally, onRally } = props;
  const { moveStatus = null, onMove, onCancelMove, onRestartApp = null } = props;
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Last selection scrolled to — a new pick (or its card first appearing) scrolls once. */
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const cards = useMemo<CardModel[]>(() => {
    const byId = new Map(agents.map((a) => [a.sessionId, a]));
    // A process that exited without ever logging (a killed duplicate, an orphaned launch) is noise.
    const real = agents.filter((a) => a.alive || a.eventCount > 0);
    return partyOrder(real).map(({ agent, nested }) => {
      const name = agentName(agent);
      const subtitle = agentSubtitle(agent);
      const place = agentPlaceLabel(agent);
      const branch = agentBranch(agent);
      const parent = agent.isSquire && agent.squireOf ? (byId.get(agent.squireOf) ?? null) : null;
      const parentName = agent.isSquire ? (parent ? agentName(parent) : squireParentName(name)) : null;
      const haystack = [name, agent.title, agent.customTitle, agent.project, place, agent.shortId, branch, parentName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return { agent, name, subtitle, place, branch, nested, parent, parentName, haystack };
    });
  }, [agents]);

  const q = filter.trim().toLowerCase();
  const visible = q ? cards.filter((c) => c.haystack.includes(q)) : cards;
  // A placeholder merges away as soon as the real hero has a card.
  const carded = new Set(cards.map((c) => c.agent.sessionId));
  const dreamers = sleepers.filter(
    (s) => !carded.has(s.sessionId) && (!q || `${s.name} ${s.sessionId.slice(0, 8)} ${s.cwd}`.toLowerCase().includes(q)),
  );
  const shown = cards.length + sleepers.filter((s) => !carded.has(s.sessionId)).length;

  useEffect(() => {
    if (!selectedSessionId) {
      scrolledTo.current = null;
      return;
    }
    if (scrolledTo.current === selectedSessionId) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-session]') ?? [])].find(
      (n) => n.dataset['session'] === selectedSessionId,
    );
    if (!el) return;
    scrolledTo.current = selectedSessionId;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

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
        <span className="party-count">{shown}</span>
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
      <div className="party-create-row">
        <button
          type="button"
          className="ui-btn ui-btn-primary party-create"
          onClick={onCreateParty}
          title="Pick a place, then start a fresh Claude Code session there"
        >
          <span aria-hidden="true">✦</span> Create Party <span className="party-create-sub">(New Session)</span>
        </button>
      </div>
      {onMove && onCancelMove && (
        <MoveCard status={moveStatus} onMove={onMove} onCancel={onCancelMove} onRestart={onRestartApp} />
      )}
      {rally && onRally && <RallyCard rally={rally} onRally={onRally} />}
      <div className="party-list" ref={listRef}>
        {shown === 0 && (
          <div className="party-empty">
            No heroes yet.
            <br />
            Start a Claude Code session.
          </div>
        )}
        {shown > 0 && visible.length === 0 && dreamers.length === 0 && (
          <div className="party-empty">No hero matches “{filter.trim()}”.</div>
        )}
        {visible.map(({ agent: a, name, subtitle, place, branch, nested, parent, parentName }) => {
          const color = heroColor(a.sessionId);
          const activity = activityLine(a);
          const selected = a.sessionId === selectedSessionId;
          const epithet = epithetOf(a.sessionId, name, a.isSquire);
          const squires = activeSquires(a);
          const offline = !a.alive && a.pid !== null;
          // Not the user's turn while a squire is still out — the main turn may resume on its own.
          const yourTurn = a.alive && (a.status === 'done' || a.ccStatus === 'idle') && squires.length === 0;
          const goParent = parent ? () => onSelect(parent.sessionId) : null;
          const shownBranch = featureBranch(branch);
          // The session id and raw tool detail live here only — the card shows the friendly bits.
          const tooltip = [
            heroTitle(a),
            subtitle ? `“${subtitle}”` : null,
            `${a.shortId}${branch ? ` · ⎇ ${branch}` : ''}`,
            a.tool ? [a.tool, a.detail].filter(Boolean).join(': ') : null,
            'click: open terminal & focus in the village',
          ]
            .filter(Boolean)
            .join('\n');
          const classes = [
            'party-card',
            selected ? 'party-card-selected' : '',
            a.isSquire ? 'party-card-squire' : '',
            nested ? 'party-card-nested' : '',
          ].join(' ');
          return (
            <button
              key={a.sessionId}
              type="button"
              data-session={a.sessionId}
              className={classes}
              style={a.isSquire ? ({ '--hero': color } as CSSProperties) : undefined}
              aria-pressed={selected}
              onClick={() => onSelect(a.sessionId)}
              title={tooltip}
            >
              {/* Portrait beside the title block; the wider rows run full-width underneath. */}
              <span className="party-top">
                <Portrait sessionId={a.sessionId} color={color} scale={2} squire={a.isSquire} className="party-avatar" />
                <span className="party-body">
                  {/* Prefix / suffix decorate the name; the name itself wraps rather than truncates. */}
                  <span className="party-hero">
                    {epithet.prefix && <span className="ui-epithet-pre">{epithet.prefix} </span>}
                    <span className="party-name">{name}</span>
                    {epithet.suffix && <span className="ui-epithet-suf"> {epithet.suffix}</span>}
                  </span>
                  {/* Last tool failure as a monster chip; clears when the server nulls lastError. */}
                  {a.lastError && (
                    <span
                      className="party-error"
                      title={[a.lastError.tool ?? 'Error', a.lastError.detail].filter(Boolean).join(': ')}
                    >
                      <span className="party-error-tool">👾 {a.lastError.tool ?? 'Error'}</span>{' '}
                      {a.lastError.detail && <span className="party-error-text">{a.lastError.detail}</span>}{' '}
                      {(a.errorStreak ?? 0) >= 2 && <span className="party-error-n">×{a.errorStreak}</span>}
                    </span>
                  )}
                  {subtitle && (
                    <span className="party-subtitle" title={subtitle}>
                      {subtitle}
                    </span>
                  )}
                  {a.isSquire && parentName && (
                    <span
                      className={`party-squire-chip ${goParent ? 'party-squire-chip-link' : ''}`}
                      role={goParent ? 'link' : undefined}
                      tabIndex={goParent ? 0 : undefined}
                      title={goParent ? `Go to ${parentName}` : `${parentName} is not in the party`}
                      onClick={
                        goParent
                          ? (e) => {
                              e.stopPropagation();
                              goParent();
                            }
                          : undefined
                      }
                      onKeyDown={
                        goParent
                          ? (e) => {
                              if (e.key !== 'Enter' && e.key !== ' ') return;
                              e.preventDefault();
                              e.stopPropagation();
                              goParent();
                            }
                          : undefined
                      }
                    >
                      ⚔ squire of {parentName}
                    </span>
                  )}
                  {(offline || yourTurn || a.status === 'delegating') && (
                    <span className="party-badges">
                      {offline && (
                        <span className="party-badge party-badge-offline" title="The Claude Code process has exited">
                          Offline
                        </span>
                      )}
                      {yourTurn && <span className="party-badge">Your turn</span>}
                      {a.status === 'delegating' && (
                        <span
                          className="party-badge party-badge-squire"
                          title={
                            squires.length > 0
                              ? squires.map((s) => s.description ?? 'Unnamed squire').join('\n')
                              : 'A sub-agent is still working'
                          }
                        >
                          Squire out ×{Math.max(1, squires.length)}
                        </span>
                      )}
                    </span>
                  )}
                  <span className="party-flavor">{flavorLine(a)}</span>
                  <span className="party-sub">
                    <span className="party-place">{place}</span>
                    {shownBranch && (
                      <>
                        <span className="party-sep">·</span>
                        <span className="party-branch">⎇ {shownBranch}</span>
                      </>
                    )}
                  </span>
                </span>
              </span>
              <span className="party-foot">
                <StatusPill status={a.status} />
                {activity && <span className="party-activity">{activity}</span>}
                <span className="party-when">{relTime(a.lastEventAt, now + skewMs)}</span>
              </span>
            </button>
          );
        })}
        {dreamers.map((s) => (
          <SleeperCard key={s.sessionId} hero={s} selected={s.sessionId === selectedSessionId} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

/** Placeholder for a hero whose terminal came back after a restart but isn't running (or listed) yet. */
function SleeperCard({ hero: s, selected, onSelect }: { hero: SleepingHero; selected: boolean; onSelect: (id: string) => void }) {
  const color = heroColor(s.sessionId);
  const place = agentPlaceLabel({ cwd: s.cwd, rootCwd: s.rootCwd, title: null, customTitle: s.name });
  const line = s.asleep ? 'asleep in the tavern — click to wake' : 'waking up…';
  return (
    <button
      type="button"
      data-session={s.sessionId}
      className={`party-card party-card-sleeper ${selected ? 'party-card-selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(s.sessionId)}
      title={`${s.name}\n${s.sessionId.slice(0, 8)} · restored terminal tab\nclick: open its terminal`}
    >
      <span className="party-top">
        <Portrait sessionId={s.sessionId} color={color} scale={2} squire={s.squire} className="party-avatar" />
        <span className="party-body">
          <span className="party-hero">
            <span className="party-name">{s.name}</span>
          </span>
          <span className="party-flavor">{line}</span>
          <span className="party-sub">
            <span className="party-place">{place}</span>
          </span>
        </span>
      </span>
      <span className="party-foot">
        <span className="party-pill party-pill-sleeper" title="Restored after a restart">
          💤 {s.asleep ? 'Asleep' : 'Waking'}
        </span>
      </span>
    </button>
  );
}
