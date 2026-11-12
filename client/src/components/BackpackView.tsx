// Backpack quest log: one row (or grid tile) per finished task, newest first,
// grouped under date headers. Rows show the item, the task's resolution, the
// hero, the place and when; hover/focus asks the panel for the full popover.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { AgentState, ItemDef, JournalEntry } from '../types/agent';
import type { ProjectHome } from '../utils/rewards';
import { dayKey, dayLabel, entryHome, entryName, homeLabel, lookupItem, relTime, summaryPreview } from '../utils/rewards';
import { heroColor } from '../utils/spriteMapper';
import { ItemIcon } from './ItemIcon';
import { BagIcon } from './PixelIcon';
import { Portrait } from './Portrait';
import { PlaceKindIcon } from './RewardsProjectHeader';

export type BackpackMode = 'list' | 'grid';

interface BackpackViewProps {
  /** Filtered quest log, newest first (the full list; `limit` caps what renders). */
  entries: JournalEntry[];
  limit: number;
  /** True when the unfiltered log is empty (vs. an empty filter). */
  emptyLog: boolean;
  mode: BackpackMode;
  catalog: Map<string, ItemDef>;
  homes: Map<string, ProjectHome>;
  agents: AgentState[];
  /** Server-adjusted clock for relative times. */
  now: number;
  /** Entry that just arrived (brief highlight). */
  flashId: string | null;
  onHover: (entry: JournalEntry, el: HTMLElement) => void;
  onLeave: () => void;
  onSelectAgent: (sessionId: string) => void;
  onSelectPlace: (placeId: string, repoId: string | null) => void;
}

const tasksCaption = (n: number): string => `${n} task${n === 1 ? '' : 's'}`;

export default function BackpackView(props: BackpackViewProps) {
  const { entries, limit, emptyLog, mode, catalog, homes, agents, now, flashId, onHover, onLeave, onSelectAgent, onSelectPlace } =
    props;

  // Day totals over the whole filtered log, so a header never undercounts a cut day.
  const dayCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of entries) {
      const k = dayKey(j.ts);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [entries]);

  if (emptyLog) {
    return (
      <div className="rp-empty">
        <BagIcon className="rp-empty-icon" />
        <div className="rp-empty-title">The backpack is empty</div>
        <div className="rp-empty-hint">Finish a task and the hero brings something home.</div>
      </div>
    );
  }
  if (entries.length === 0) return <div className="rp-none">Nothing earned here yet.</div>;

  const inParty = new Set(agents.map((a) => a.sessionId));
  const shown = entries.slice(0, limit);

  // Split the shown slice into consecutive day runs.
  const days: { key: string; ts: number; items: JournalEntry[] }[] = [];
  for (const j of shown) {
    const k = dayKey(j.ts);
    const last = days.at(-1);
    if (last && last.key === k) last.items.push(j);
    else days.push({ key: k, ts: j.ts, items: [j] });
  }

  const hoverProps = (j: JournalEntry) => ({
    'data-entry': j.id,
    onMouseEnter: (e: { currentTarget: HTMLElement }) => onHover(j, e.currentTarget),
    onMouseLeave: onLeave,
    onFocus: (e: { currentTarget: HTMLElement }) => onHover(j, e.currentTarget),
    onBlur: onLeave,
  });

  const row = (j: JournalEntry): ReactNode => {
    const item = lookupItem(catalog, j.itemId);
    const home = entryHome(j, homes);
    const place = homeLabel(home, j.project);
    const name = entryName(j, agents);
    const preview = summaryPreview(j.summary);
    const live = inParty.has(j.sessionId);
    const abs = new Date(j.ts).toLocaleString();
    return (
      <li
        key={j.id}
        className={`bp-row ${flashId === j.id ? 'bp-row-new' : ''}`}
        tabIndex={0}
        aria-label={`${preview ?? 'Task finished'} — ${name}, ${place}, ${abs}`}
        {...hoverProps(j)}
      >
        <span className={`bp-icon bp-r-${item.rarity}`}>
          <ItemIcon itemId={item.id} scale={1} />
        </span>
        <span className="bp-main">
          <span className={`bp-summary ${preview ? '' : 'bp-summary-none'}`}>{preview ?? 'Task finished — no summary'}</span>
          <span className="bp-meta">
            <button
              type="button"
              className="bp-hero"
              disabled={!live}
              onClick={(e) => {
                e.stopPropagation();
                onSelectAgent(j.sessionId);
              }}
              title={live ? `Open ${name} in the terminal` : `${name} — not in the party any more`}
            >
              <Portrait sessionId={j.sessionId} color={heroColor(j.sessionId)} className="bp-hero-portrait" />
              <span className="bp-hero-name">{name}</span>
            </button>
            <span className="bp-dot" aria-hidden="true">
              ·
            </span>
            {home.onMap ? (
              <button
                type="button"
                className="bp-place bp-place-link"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPlace(home.place.id, home.repo?.id ?? null);
                }}
                title={`Start a quest in ${place}`}
              >
                <PlaceKindIcon place={home.place} />
                <span className="bp-place-text">{place}</span>
              </button>
            ) : (
              <span className="bp-place" title={j.cwd ?? j.project}>
                <PlaceKindIcon place={home.place} />
                <span className="bp-place-text">{place}</span>
              </span>
            )}
          </span>
        </span>
        <time className="bp-time" dateTime={new Date(j.ts).toISOString()} title={abs}>
          {relTime(j.ts, now)}
        </time>
      </li>
    );
  };

  const tile = (j: JournalEntry): ReactNode => {
    const item = lookupItem(catalog, j.itemId);
    return (
      <button
        key={j.id}
        type="button"
        className={`bp-tile bp-r-${item.rarity} ${flashId === j.id ? 'bp-row-new' : ''}`}
        aria-label={`${summaryPreview(j.summary) ?? 'Task finished'} — ${entryName(j, agents)}`}
        {...hoverProps(j)}
      >
        <ItemIcon itemId={item.id} scale={1} />
      </button>
    );
  };

  return (
    <>
      {days.map((d) => (
        <section key={d.key} className="bp-day">
          <h3 className="bp-day-head">
            <span className="bp-day-name">{dayLabel(d.ts, now)}</span>
            <span className="bp-day-n">{tasksCaption(dayCounts.get(d.key) ?? d.items.length)}</span>
          </h3>
          {mode === 'list' ? <ul className="bp-list">{d.items.map(row)}</ul> : <div className="bp-grid">{d.items.map(tile)}</div>}
        </section>
      ))}
    </>
  );
}
