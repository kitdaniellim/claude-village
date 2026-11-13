// Left "Party" panel — also the terminal list: one compact card per agent, in the order the user
// drags them into (new heroes join at the bottom; nothing re-sorts itself), squires under their
// parent. Ids and raw tool detail live in the tooltip; the filter still matches them.
// Click → select (village + drawer switches to its terminal). Hover ✕ → dismiss (ends the session).
// "Create Party" at the top opens a fresh Nameless terminal (choose the project from inside Claude).
// Restored terminal tabs whose hero the server does not list yet get a dimmed placeholder card.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { usePersistentState } from '../hooks/usePersistentState';
import type { AgentState, AgentStatus, RallySession, ReviewVerdict, SquireInfo } from '../types/agent';
import type { Rally } from '../hooks/useRally';
import RallyCard from './RallyCard';
import MoveCard from './MoveCard';
import type { MoveStatus } from './TerminalPanel';
import type { BlockedMap, BlockedMark, SleepingHero } from '../utils/terminalTabs';
import { STATUS_COLORS, STATUS_LABELS, heroColor } from '../utils/spriteMapper';
import { flavorLine } from '../utils/flavor';
import {
  activityLine,
  agentBranch,
  agentName,
  agentPlaceLabel,
  agentSubtitle,
  isLeader,
  LEADER_NAME,
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
  /** ✕ confirmed on a card: end that session and drop it from the party. */
  onDismiss?: (sessionId: string) => void;
  /** Sessions marked Blocked (UI only), with their optional note. */
  blocked?: BlockedMap;
  /** Party Leader: opted-in sessions, its latest verdicts, who's queued / in review, and recruiting. */
  reviewIds?: string[];
  verdicts?: ReviewVerdict[];
  reviewQueue?: string[];
  onRecruitLeader?: () => void;
}

/** Saved party order (session ids, `tab:<id>` for launches); prefs values are size-capped. */
const MAX_ORDER = 80;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Sub-agents still working for this hero (older server snapshots omit the field). */
function activeSquires(a: AgentState): SquireInfo[] {
  return (a.squires ?? []).filter((s) => s.active);
}

/** Squires that sit under a parent card (the parent is in the party). */
function nestedIn(agents: AgentState[]): (a: AgentState) => boolean {
  const present = new Set(agents.map((a) => a.sessionId));
  return (a) => a.isSquire && a.squireOf !== null && a.squireOf !== a.sessionId && present.has(a.squireOf);
}

/** Status pill (dot + label, ✓ when done) — shared with the drawer's session card. `yourTurn` lights it up. */
export function StatusPill({ status, yourTurn = false }: { status: AgentStatus; yourTurn?: boolean }) {
  return (
    <span
      className={`party-pill party-pill-${status} ${yourTurn ? 'party-pill-yourturn' : ''}`}
      title={yourTurn ? 'Your turn — Claude is waiting for you' : status}
    >
      <span className="party-dot" style={{ background: STATUS_COLORS[status] }} />
      {(status === 'done' || yourTurn) && <span className="party-pill-check">✓</span>}
      {yourTurn ? 'Your turn' : STATUS_LABELS[status]}
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
  const { moveStatus = null, onMove, onCancelMove, onRestartApp = null, onDismiss, blocked = {} } = props;
  const { reviewIds = [], verdicts = [], reviewQueue = [], onRecruitLeader } = props;
  const hasLeader = agents.some((a) => a.alive && isLeader(a)) || sleepers.some((s) => s.name.trim().toUpperCase() === LEADER_NAME);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState('');
  const [order, setOrder] = usePersistentState<string[]>('party-order', [], isStringArray);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
    const isNested = nestedIn(real);
    return real.map((agent) => {
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
      return { agent, name, subtitle, place, branch, nested: isNested(agent), parent, parentName, haystack };
    });
  }, [agents]);

  // A placeholder merges away as soon as the real hero has a card.
  const carded = new Set(cards.map((c) => c.agent.sessionId));
  const sleeping = sleepers.filter((s) => !carded.has(s.sessionId));
  const shown = cards.length + sleeping.length;

  // Every id on show, in first-seen order — new ones join the saved order at the bottom.
  const presentIds = useMemo(() => [...cards.map((c) => c.agent.sessionId), ...sleeping.map((s) => s.sessionId)], [cards, sleeping]);
  const presentKey = presentIds.join('|');
  useEffect(() => {
    setOrder((cur) => {
      const missing = presentIds.filter((id) => !cur.includes(id));
      if (missing.length === 0) return cur;
      const next = [...cur, ...missing];
      if (next.length <= MAX_ORDER) return next;
      // Over the cap: drop the oldest ids that aren't on show any more.
      const present = new Set(presentIds);
      const drop = next.length - MAX_ORDER;
      let dropped = 0;
      return next.filter((id) => present.has(id) || dropped++ >= drop);
    });
  }, [presentKey, setOrder]);

  const rank = useMemo(() => new Map(order.map((id, i) => [id, i])), [order]);
  const byRank = (a: string, b: string): number => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity);

  const q = filter.trim().toLowerCase();
  const visibleCards = q ? cards.filter((c) => c.haystack.includes(q)) : cards;
  const visibleSleepers = sleeping.filter(
    (s) => !q || `${s.name} ${s.sessionId.slice(0, 8)} ${s.cwd}`.toLowerCase().includes(q),
  );

  // Top-level slots in the user's order; squires follow their parent.
  type Slot = { id: string; card?: CardModel; sleeper?: SleepingHero; children: CardModel[] };
  const slots: Slot[] = [];
  const childrenOf = new Map<string, CardModel[]>();
  for (const c of visibleCards) {
    if (!c.nested) continue;
    const pid = c.agent.squireOf as string;
    childrenOf.set(pid, [...(childrenOf.get(pid) ?? []), c]);
  }
  for (const c of visibleCards) {
    if (c.nested) continue;
    const kids = (childrenOf.get(c.agent.sessionId) ?? []).sort((a, b) => byRank(a.agent.sessionId, b.agent.sessionId));
    slots.push({ id: c.agent.sessionId, card: c, children: kids });
  }
  // A squire whose parent is filtered out still shows, on its own.
  const placedKids = new Set(slots.flatMap((s) => s.children.map((k) => k.agent.sessionId)));
  for (const c of visibleCards) {
    if (c.nested && !placedKids.has(c.agent.sessionId)) slots.push({ id: c.agent.sessionId, card: c, children: [] });
  }
  for (const s of visibleSleepers) slots.push({ id: s.sessionId, sleeper: s, children: [] });
  slots.sort((a, b) => byRank(a.id, b.id));

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

  // ── drag to reorder ──────────────────────────────────────────────────────
  const onDragStart = (e: ReactDragEvent<HTMLDivElement>, id: string): void => {
    setDragId(id);
    setConfirmId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>, id: string): void => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    if (dropAt?.id !== id || dropAt.after !== after) setDropAt({ id, after });
  };
  const endDrag = (): void => {
    setDragId(null);
    setDropAt(null);
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (dragId && dropAt && dragId !== dropAt.id) {
      setOrder((cur) => {
        const base = cur.includes(dragId) ? cur : [...cur, dragId];
        const without = base.filter((x) => x !== dragId);
        const at = without.indexOf(dropAt.id);
        if (at < 0) return base;
        without.splice(dropAt.after ? at + 1 : at, 0, dragId);
        return without;
      });
    }
    endDrag();
  };

  const renderCard = ({ agent: a, name, subtitle, branch, nested, parent, parentName }: CardModel): ReactNode => {
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
    // The session id, place and raw tool detail live here only — the card shows the friendly bits.
    const mark = blocked[a.sessionId];
    const tooltip = [
      heroTitle(a),
      mark ? `⛔ Blocked${mark.note ? `: ${mark.note}` : ''}` : null,
      subtitle ? `“${subtitle}”` : null,
      agentPlaceLabel(a),
      `${a.shortId}${branch ? ` · ⎇ ${branch}` : ''}`,
      a.tool ? [a.tool, a.detail].filter(Boolean).join(': ') : null,
      'click: open its terminal · drag: reorder',
    ]
      .filter(Boolean)
      .join('\n');
    const classes = [
      'party-card',
      selected ? 'party-card-selected' : '',
      yourTurn ? 'party-card-yourturn' : '',
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
        {/* Portrait beside the title block; the status row runs full-width underneath. */}
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
            {(offline || a.status === 'delegating' || blocked[a.sessionId] || isLeader(a) || reviewIds.includes(a.sessionId)) && (
              <span className="party-badges">
                {isLeader(a) && (
                  <span className="party-badge party-badge-leader" title="Party Leader — reviews opted-in parties when they finish a turn">
                    👑 Party Leader
                  </span>
                )}
                {!isLeader(a) && reviewIds.includes(a.sessionId) && (
                  <ReviewBadge verdict={verdicts.find((v) => v.sessionId === a.sessionId) ?? null} queued={reviewQueue.includes(a.sessionId)} />
                )}
                {blocked[a.sessionId] && <BlockedBadge mark={blocked[a.sessionId] as BlockedMark} />}
                {offline && (
                  <span className="party-badge party-badge-offline" title="The Claude Code process has exited">
                    Offline
                  </span>
                )}
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
            {shownBranch && <span className="party-branch">⎇ {shownBranch}</span>}
          </span>
        </span>
        <span className="party-foot">
          <StatusPill status={a.status} yourTurn={yourTurn} />
          {activity && <span className="party-activity">{activity}</span>}
          <span className="party-when">{relTime(a.lastEventAt, now + skewMs)}</span>
        </span>
      </button>
    );
  };

  /** Hover ✕ → inline "End this session?" — the card's own button can't hold another button. */
  const dismissControls = (id: string, name: string): ReactNode =>
    !onDismiss ? null : confirmId === id ? (
      <div className="party-dismiss-confirm" role="alertdialog" aria-label={`Dismiss ${name}?`}>
        <span>End {name}?</span>
        <button
          type="button"
          className="ui-btn party-dismiss-yes"
          onClick={() => {
            setConfirmId(null);
            onDismiss(id);
          }}
        >
          Dismiss
        </button>
        <button type="button" className="ui-btn party-dismiss-no" onClick={() => setConfirmId(null)}>
          Keep
        </button>
      </div>
    ) : (
      <button
        type="button"
        className="party-dismiss"
        aria-label={`Dismiss ${name}`}
        title="Dismiss — ends this session and removes it from the party"
        onClick={() => setConfirmId(id)}
      >
        ✕
      </button>
    );

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
      {onRecruitLeader && !hasLeader && (
        <div className="party-create-row party-leader-row">
          <button
            type="button"
            className="ui-btn party-recruit"
            onClick={onRecruitLeader}
            title="Start a PARTY LEADER session that reviews opted-in parties (👑 Review in the drawer) whenever they finish a turn"
          >
            👑 Recruit Party Leader
          </button>
        </div>
      )}
      {onMove && onCancelMove && (
        <MoveCard status={moveStatus} onMove={onMove} onCancel={onCancelMove} onRestart={onRestartApp} />
      )}
      {rally && onRally && <RallyCard rally={rally} onRally={onRally} />}
      <div className="party-list" ref={listRef} onDragEnd={endDrag}>
        {shown === 0 && (
          <div className="party-empty">
            No heroes yet.
            <br />
            Start a Claude Code session.
          </div>
        )}
        {shown > 0 && slots.length === 0 && <div className="party-empty">No hero matches “{filter.trim()}”.</div>}
        {slots.map((slot) => {
          const name = slot.card ? slot.card.name : (slot.sleeper?.name ?? '');
          const classes = [
            'party-slot',
            dragId === slot.id ? 'party-slot-dragging' : '',
            dropAt?.id === slot.id ? (dropAt.after ? 'party-slot-drop-after' : 'party-slot-drop-before') : '',
          ].join(' ');
          return (
            <div
              key={slot.id}
              className={classes}
              draggable={!q}
              onDragStart={(e) => onDragStart(e, slot.id)}
              onDragOver={(e) => onDragOver(e, slot.id)}
              onDrop={onDrop}
            >
              {slot.card
                ? renderCard(slot.card)
                : slot.sleeper && (
                    <SleeperCard
                      hero={slot.sleeper}
                      selected={slot.id === selectedSessionId}
                      onSelect={onSelect}
                      mark={blocked[slot.sleeper.sessionId] ?? null}
                    />
                  )}
              {dismissControls(slot.id, name)}
              {slot.children.map((kid) => (
                <div key={kid.agent.sessionId} className="party-slot party-slot-kid">
                  {renderCard(kid)}
                  {dismissControls(kid.agent.sessionId, kid.name)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** Placeholder for a hero whose terminal came back after a restart (or a launch not yet adopted). */
/** Where an opted-in party stands with the Leader; the note shows on hover. */
function ReviewBadge({ verdict, queued }: { verdict: ReviewVerdict | null; queued: boolean }) {
  if (queued) {
    return (
      <span className="party-badge party-badge-review" title="Waiting for the Party Leader's review">
        👑 Reviewing…
      </span>
    );
  }
  if (!verdict) {
    return (
      <span className="party-badge party-badge-review" title="The Party Leader reviews this party when it finishes a turn">
        👑 Review on
      </span>
    );
  }
  const label =
    verdict.verdict === 'approved' ? '👑 ✓ Approved' : verdict.verdict === 'changes' ? `👑 Fixing · round ${verdict.round}` : '👑 Needs you';
  return (
    <span className={`party-badge party-badge-review party-badge-review-${verdict.verdict}`} title={verdict.note || label}>
      {label}
    </span>
  );
}

/** Red BLOCKED chip; hovering shows the note (the label is a reminder — nothing else changes). */
function BlockedBadge({ mark }: { mark: BlockedMark }) {
  return (
    <span className="party-badge party-badge-blocked" title={mark.note ? `Blocked: ${mark.note}` : 'Blocked — no note'}>
      ⛔ Blocked
    </span>
  );
}

function SleeperCard({
  hero: s,
  selected,
  onSelect,
  mark,
}: {
  hero: SleepingHero;
  selected: boolean;
  onSelect: (id: string) => void;
  mark: BlockedMark | null;
}) {
  const color = heroColor(s.sessionId);
  const line = s.launching
    ? s.asleep
      ? 'restored — click to start'
      : 'setting out…'
    : s.asleep
      ? 'asleep in the tavern — click to wake'
      : 'waking up…';
  return (
    <button
      type="button"
      data-session={s.sessionId}
      className={`party-card party-card-sleeper ${selected ? 'party-card-selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(s.sessionId)}
      title={`${s.name}\n${s.launching ? 'new session' : `${s.sessionId.slice(0, 8)} · restored terminal tab`}\nclick: open its terminal · drag: reorder`}
    >
      <span className="party-top">
        <Portrait sessionId={s.sessionId} color={color} scale={2} squire={s.squire} className="party-avatar" />
        <span className="party-body">
          <span className="party-hero">
            <span className="party-name">{s.name}</span>
          </span>
          {mark && (
            <span className="party-badges">
              <BlockedBadge mark={mark} />
            </span>
          )}
          <span className="party-flavor">{line}</span>
        </span>
      </span>
      <span className="party-foot">
        <span className="party-pill party-pill-sleeper" title={s.launching ? 'Starting a new session' : 'Restored after a restart'}>
          {s.launching ? '✦ New' : `💤 ${s.asleep ? 'Asleep' : 'Waking'}`}
        </span>
      </span>
    </button>
  );
}
