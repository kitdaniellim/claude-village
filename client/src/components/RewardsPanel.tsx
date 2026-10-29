// Backpack overlay (top-right of the village): the quest log — one earned item
// per finished task, newest first, with place chips, List/Grid, paging and a
// hover popover holding the full resolution. Closes on outside click.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { AgentState, ItemDef, JournalEntry, RewardsState } from '../types/agent';
import { usePersistentState } from '../hooks/usePersistentState';
import type { ProjectHome } from '../utils/rewards';
import {
  catalogMap,
  cleanSummary,
  clockTime,
  entryHome,
  entryName,
  groupProjects,
  homeLabel,
  lookupItem,
  projectHomes,
  projectList,
  relTime,
} from '../utils/rewards';
import { heroColor } from '../utils/spriteMapper';
import { BagIcon, PixelIcon } from './PixelIcon';
import BackpackView from './BackpackView';
import type { BackpackMode } from './BackpackView';
import { ItemIcon } from './ItemIcon';
import { Portrait } from './Portrait';
import { LoadMore, usePagedLimit } from './RewardsPaging';
import { PlaceKindIcon } from './RewardsProjectHeader';
import './RewardsPanel.css';

export interface RewardsPanelProps {
  open: boolean;
  onClose: () => void;
  rewards: RewardsState | null;
  /** Live party — hero names are clickable only when present here. */
  agents: AgentState[];
  skewMs: number;
  onSelectAgent: (sessionId: string) => void;
  onSelectPlace: (placeId: string, repoId: string | null) => void;
  /** Increments per award; `lastAward` is the entry that bumped it (highlight its row). */
  awardNonce: number;
  lastAward: JournalEntry | null;
}

const PAGE = 30;
const FLASH_MS = 1600;
const POP_W = 340;
const POP_GAP = 10;
/** Grace period to move the pointer from a row onto the popover. */
const CLOSE_DELAY_MS = 160;

const isMode = (v: unknown): v is BackpackMode => v === 'list' || v === 'grid';

interface HoverState {
  entry: JournalEntry;
  rect: DOMRect;
}

export default function RewardsPanel(props: RewardsPanelProps) {
  const { open, onClose, rewards, agents, skewMs, onSelectAgent, onSelectPlace, awardNonce, lastAward } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [placeFilter, setPlaceFilter] = useState<string | null>(null);
  const [mode, setMode] = usePersistentState<BackpackMode>('backpack-mode', 'list', isMode);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const catalog = useMemo(() => catalogMap(rewards), [rewards]);
  const homes = useMemo(() => projectHomes(rewards), [rewards]);
  const journal = useMemo(() => [...(rewards?.journal ?? [])].sort((a, b) => b.ts - a.ts), [rewards]);
  const places = useMemo(() => groupProjects(projectList(rewards), homes), [rewards, homes]);

  const chipCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of journal) {
      const id = entryHome(j, homes).place.id;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [journal, homes]);

  const entries = useMemo(
    () => (placeFilter === null ? journal : journal.filter((j) => entryHome(j, homes).place.id === placeFilter)),
    [journal, homes, placeFilter],
  );
  const { limit, more } = usePagedLimit(entries.length, PAGE, placeFilter ?? '*');

  // A filtered place that the server pruned falls back to All.
  useEffect(() => {
    if (placeFilter !== null && !places.some((g) => g.place.id === placeFilter)) setPlaceFilter(null);
  }, [places, placeFilter]);

  // New filter, mode or reopen starts at the top.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [placeFilter, mode, open]);

  // Outside click closes — except on the top-bar toggle and the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (rootRef.current?.contains(t)) return;
      if (t.closest('[data-rewards-toggle], .bp-pop')) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  // Relative times tick every 30 s while open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [open]);

  // Fresh award → its row (at the top) glows briefly.
  useEffect(() => {
    if (awardNonce === 0 || !lastAward) return;
    setFlashId(lastAward.id);
    const id = window.setTimeout(() => setFlashId(null), FLASH_MS);
    return () => window.clearTimeout(id);
  }, [awardNonce, lastAward]);

  // The popover never outlives the row it points at.
  useEffect(() => {
    setHover(null);
  }, [open, placeFilter, mode]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const showHover = useCallback((entry: JournalEntry, el: HTMLElement) => {
    window.clearTimeout(closeTimer.current);
    setHover({ entry, rect: el.getBoundingClientRect() });
  }, []);
  const scheduleClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(null), CLOSE_DELAY_MS);
  }, []);
  const keepOpen = useCallback(() => window.clearTimeout(closeTimer.current), []);

  if (!open) return null;

  const clockNow = now + skewMs;
  const total = journal.length;

  return (
    <div className="rp" ref={rootRef} role="dialog" aria-label="Backpack">
      <div className="ui-head rp-head">
        <BagIcon open className="rp-head-icon" />
        <span className="ui-title">Backpack</span>
        <span className="ui-count" title="Rewards in the quest log">
          {total}
        </span>
        <span className="rp-head-sub">quest log</span>
        <div className="rp-tabs" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={mode === 'list'}
            className={`rp-tab ${mode === 'list' ? 'rp-tab-on' : ''}`}
            onClick={() => setMode('list')}
          >
            List
          </button>
          <button
            type="button"
            aria-pressed={mode === 'grid'}
            className={`rp-tab ${mode === 'grid' ? 'rp-tab-on' : ''}`}
            onClick={() => setMode('grid')}
          >
            Grid
          </button>
        </div>
        <button type="button" className="ui-btn ui-btn-icon rp-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <PixelIcon name="x" />
        </button>
      </div>

      {places.length > 0 && (
        <div className="rp-chips" role="group" aria-label="Filter by place">
          <button
            type="button"
            className={`ui-chip ${placeFilter === null ? 'ui-chip-on' : ''}`}
            aria-pressed={placeFilter === null}
            onClick={() => setPlaceFilter(null)}
          >
            All <span className="ui-chip-n">{total}</span>
          </button>
          {places
            .filter(({ place }) => (chipCounts.get(place.id) ?? 0) > 0)
            .map(({ place, subs }) => (
              <button
                key={place.id}
                type="button"
                className={`ui-chip rp-chip ${placeFilter === place.id ? 'ui-chip-on' : ''}`}
                aria-pressed={placeFilter === place.id}
                onClick={() => setPlaceFilter((cur) => (cur === place.id ? null : place.id))}
                title={`${place.name}: ${subs.map((s) => s.name).join(', ')}`}
              >
                <PlaceKindIcon place={place} />
                <span className="rp-chip-text">{place.name}</span>
                <span className="ui-chip-n">{chipCounts.get(place.id) ?? 0}</span>
              </button>
            ))}
        </div>
      )}

      {entries.length > 0 && (
        <div className="rp-sortbar">
          <span className="rp-sort" title="Latest reward at the top">
            Newest first <span aria-hidden="true">↓</span>
          </span>
          <span className="rp-showing">
            Showing {limit} of {entries.length}
          </span>
        </div>
      )}

      <div className="rp-body" ref={bodyRef} onScroll={() => setHover(null)}>
        <BackpackView
          entries={entries}
          limit={limit}
          emptyLog={total === 0}
          mode={mode}
          catalog={catalog}
          homes={homes}
          agents={agents}
          now={clockNow}
          flashId={flashId}
          onHover={showHover}
          onLeave={scheduleClose}
          onSelectAgent={onSelectAgent}
          onSelectPlace={onSelectPlace}
        />
        {entries.length > 0 && <LoadMore shown={limit} total={entries.length} pageSize={PAGE} onMore={more} />}
      </div>

      {hover && (
        <EntryPopover
          hover={hover}
          panel={rootRef.current}
          catalog={catalog}
          homes={homes}
          agents={agents}
          now={clockNow}
          onEnter={keepOpen}
          onLeave={scheduleClose}
        />
      )}
    </div>
  );
}

// ── Hover popover: the full resolution ───────────────────────────────────────

interface EntryPopoverProps {
  hover: HoverState;
  panel: HTMLElement | null;
  catalog: Map<string, ItemDef>;
  homes: Map<string, ProjectHome>;
  agents: AgentState[];
  now: number;
  onEnter: () => void;
  onLeave: () => void;
}

function EntryPopover({ hover, panel, catalog, homes, agents, now, onEnter, onLeave }: EntryPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { entry: j, rect } = hover;
  const item = lookupItem(catalog, j.itemId);
  const home = entryHome(j, homes);
  const name = entryName(j, agents);
  const body = j.summary ? cleanSummary(j.summary) : null;

  // Hidden until measured; then beside the panel (over the map) if there's room, else under/over the row.
  const [style, setStyle] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  const [side, setSide] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const pr = panel?.getBoundingClientRect() ?? null;
    const beside = pr !== null && pr.left - POP_W - POP_GAP >= 8;
    let left: number;
    let top: number;
    if (beside && pr) {
      left = pr.left - POP_W - POP_GAP;
      top = rect.top - 4;
    } else {
      left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, rect.left));
      top = rect.bottom + 6;
      if (top + h > window.innerHeight - 8) top = rect.top - 6 - h;
    }
    top = Math.max(8, Math.min(window.innerHeight - 8 - h, top));
    setSide(beside);
    setStyle({ left, top });
  }, [panel, rect, j.id]);

  const d = new Date(j.ts);
  const when = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${clockTime(j.ts)}`;

  return createPortal(
    <div
      ref={ref}
      className={`bp-pop ${side ? 'bp-pop-side' : ''}`}
      style={style}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="bp-pop-kicker">Task resolution</div>
      <div className={`bp-pop-text ${body ? '' : 'bp-pop-text-none'}`}>{body ?? 'The hero finished without a closing word.'}</div>
      <div className="bp-pop-who">
        <Portrait sessionId={j.sessionId} color={heroColor(j.sessionId)} className="bp-pop-portrait" />
        <span className="bp-pop-id">
          <span className="bp-pop-name">{name}</span>
          <span className="bp-pop-place">
            <PlaceKindIcon place={home.place} />
            {homeLabel(home, j.project)}
          </span>
        </span>
      </div>
      <div className="bp-pop-foot">
        <time dateTime={d.toISOString()}>
          {when} <span className="bp-pop-rel">({relTime(j.ts, now)})</span>
        </time>
        <span className="bp-pop-found">
          <ItemIcon itemId={item.id} scale={1} className="bp-pop-item" />
          found: {item.name}
        </span>
      </div>
    </div>,
    document.body,
  );
}
