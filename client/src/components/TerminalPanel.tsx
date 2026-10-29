// Right-side terminal drawer: resizable (width remembered), a tab strip of
// pty-backed xterm terminals (desktop app) or parchment notices (browser),
// plus the "Start a quest in <place>" chooser for building clicks.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentState } from '../types/agent';
import type { DesktopBridge } from '../types/desktop';
import type { FocusRequest } from './Village';
import { TAVERN_PLACE, allPlaces, resolveAgentPlace } from '../world/registry';
import type { PlaceDef, RepoDef } from '../world/registry';
import { heroColor } from '../utils/spriteMapper';
import { FALLBACK_CWD, agentCwd, agentName } from '../utils/agentLabel';
import { KIND_GLYPH, KIND_LABEL, makeTab } from '../utils/terminalTabs';
import type { TerminalKind, TerminalTab } from '../utils/terminalTabs';
import { clampDrawerWidth } from '../hooks/useDrawerWidth';
import XtermView from './XtermView';
import TerminalNotice from './TerminalNotice';
import './TerminalPanel.css';

export interface PlaceRequest {
  placeId: string;
  repoId: string | null;
  nonce: number;
}

export interface TerminalPanelProps {
  open: boolean;
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
  bridge: DesktopBridge | null;
  agents: AgentState[];
  /** Session picked in the party or the village — focus its tab or open one. */
  sessionRequest: FocusRequest | null;
  /** Building / city clicked — show the quest chooser for that place. */
  placeRequest: PlaceRequest | null;
}

interface Chooser {
  place: PlaceDef;
  repoId: string | null;
}

/** Places without repos (the tavern) still get one launch option: the coding root. */
function launchTargets(place: PlaceDef): RepoDef[] {
  if (place.repos.length > 0) return place.repos;
  return [{ id: place.id, name: place.name, match: [], cwd: FALLBACK_CWD }];
}

export default function TerminalPanel(props: TerminalPanelProps) {
  const { open, width, onWidthChange, onClose, bridge, agents, sessionRequest, placeRequest } = props;

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [dragging, setDragging] = useState(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const addTab = useCallback((init: Omit<TerminalTab, 'id'>): void => {
    const tab = makeTab(init);
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
    setChooser(null);
  }, []);

  const openForAgent = useCallback(
    (a: AgentState, kind: TerminalKind): void => {
      addTab({
        kind,
        sessionId: a.sessionId,
        name: agentName(a),
        shortId: a.shortId,
        cwd: agentCwd(a),
        color: heroColor(a.sessionId),
      });
    },
    [addTab],
  );

  /** Focus the session's resume tab, or open one (fresh agent data when still in the party). */
  const resumeSession = useCallback(
    (sessionId: string, fallback: TerminalTab | null): void => {
      const existing = tabsRef.current.find((t) => t.kind === 'resume' && t.sessionId === sessionId);
      if (existing) {
        setActiveId(existing.id);
        setChooser(null);
        return;
      }
      const a = agentsRef.current.find((x) => x.sessionId === sessionId);
      if (a) openForAgent(a, 'resume');
      else if (fallback) addTab({ ...fallback, kind: 'resume' });
    },
    [addTab, openForAgent],
  );

  const closeTab = useCallback((id: string): void => {
    const t = tabsRef.current;
    const idx = t.findIndex((x) => x.id === id);
    const next = t.filter((x) => x.id !== id);
    setTabs(next);
    setActiveId((cur) => (cur === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : cur));
  }, []);

  useEffect(() => {
    if (!sessionRequest) return;
    resumeSession(sessionRequest.sessionId, null);
  }, [sessionRequest, resumeSession]);

  useEffect(() => {
    if (!placeRequest) return;
    const place = [...allPlaces(), TAVERN_PLACE].find((p) => p.id === placeRequest.placeId);
    if (place) setChooser({ place, repoId: placeRequest.repoId });
  }, [placeRequest]);

  // ── Resize handle ──────────────────────────────────────────────────────────
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    const move = (ev: PointerEvent): void => {
      onWidthChange(clampDrawerWidth(window.innerWidth - ev.clientX));
    };
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      setDragging(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    e.preventDefault();
  };

  const active = chooser ? null : (tabs.find((t) => t.id === activeId) ?? null);

  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setActiveId(id);
      setChooser(null);
    }
  };

  return (
    <aside
      className={`drawer ${open ? '' : 'drawer-closed'} ${dragging ? 'drawer-dragging' : ''}`}
      style={{ width }}
      aria-hidden={!open}
    >
      <div
        className="drawer-handle"
        onPointerDown={onHandleDown}
        onDoubleClick={() => onWidthChange(window.innerWidth * 0.44)}
        title="Drag to resize · double-click to reset"
      />

      <div className="drawer-head">
        <span className="drawer-title">Terminals</span>
        <span className="drawer-count">{tabs.length}</span>
        <span className="drawer-hint">
          <kbd>Ctrl</kbd>+<kbd>`</kbd>
        </span>
        <button type="button" className="drawer-close" onClick={onClose} title="Close drawer (Esc)">
          ×
        </button>
      </div>

      <div className="drawer-tabs" role="tablist">
        {tabs.map((t) => {
          const isActive = !chooser && t.id === activeId;
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              className={`drawer-tab ${isActive ? 'drawer-tab-active' : ''}`}
              onClick={() => {
                setActiveId(t.id);
                setChooser(null);
              }}
              onKeyDown={(e) => onTabKey(e, t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(t.id);
              }}
              title={`${KIND_LABEL[t.kind]} · ${t.cwd}`}
            >
              <span className="drawer-tab-glyph" style={{ color: t.color }}>
                {KIND_GLYPH[t.kind]}
              </span>
              <span className="drawer-tab-label">{t.name}</span>
              <button
                type="button"
                className="drawer-tab-x"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {chooser && (
          <div role="tab" aria-selected className="drawer-tab drawer-tab-active drawer-tab-chooser">
            <span className="drawer-tab-glyph">✦</span>
            <span className="drawer-tab-label">New quest</span>
          </div>
        )}
      </div>

      {active && (
        <div className="drawer-session">
          <div className="drawer-session-main">
            <span className="drawer-session-dot" style={{ background: active.color }} />
            <span className="drawer-session-name">{active.name}</span>
            {active.shortId && <span className="drawer-session-id">{active.shortId}</span>}
            <span className="drawer-session-kind">{KIND_LABEL[active.kind]}</span>
          </div>
          <div className="drawer-session-cwd" title={active.cwd}>
            {active.cwd}
          </div>
          <div className="drawer-actions">
            {active.sessionId && active.kind !== 'resume' && (
              <button
                type="button"
                className="drawer-btn drawer-btn-primary"
                onClick={() => resumeSession(active.sessionId ?? '', active)}
              >
                ↻ Resume
              </button>
            )}
            <button
              type="button"
              className="drawer-btn"
              onClick={() => addTab({ ...active, kind: 'new' })}
              title={`Fresh claude in ${active.cwd}`}
            >
              ✦ New session here
            </button>
            <button
              type="button"
              className="drawer-btn"
              onClick={() => addTab({ ...active, kind: 'shell' })}
              title={`Plain shell in ${active.cwd}`}
            >
              $ Shell
            </button>
            <button
              type="button"
              className="drawer-btn drawer-btn-danger"
              onClick={() => closeTab(active.id)}
            >
              × Close tab
            </button>
          </div>
        </div>
      )}

      <div className="drawer-body">
        {tabs.map((t) => {
          const isActive = !chooser && t.id === activeId;
          return (
            <div key={t.id} className={`drawer-pane ${isActive ? '' : 'drawer-pane-hidden'}`}>
              {bridge ? <XtermView bridge={bridge} tab={t} active={isActive && open} /> : <TerminalNotice tab={t} />}
            </div>
          );
        })}

        {chooser && (
          <PlaceChooser
            chooser={chooser}
            agents={agents}
            hasTabs={tabs.length > 0}
            onLaunch={(repo, kind) =>
              addTab({ kind, sessionId: null, name: repo.name, shortId: null, cwd: repo.cwd, color: heroColor(repo.id) })
            }
            onResume={(a) => openForAgent(a, 'resume')}
            onBack={() => setChooser(null)}
          />
        )}

        {!chooser && tabs.length === 0 && (
          <div className="drawer-empty">
            <div className="drawer-empty-glyph">▣</div>
            <div className="drawer-empty-title">No terminals open</div>
            <div className="drawer-empty-hint">
              Pick a hero from the party, or click a building to start a quest there.
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Place chooser ────────────────────────────────────────────────────────────

interface PlaceChooserProps {
  chooser: Chooser;
  agents: AgentState[];
  hasTabs: boolean;
  onLaunch: (repo: RepoDef, kind: TerminalKind) => void;
  onResume: (a: AgentState) => void;
  onBack: () => void;
}

function PlaceChooser({ chooser, agents, hasTabs, onLaunch, onResume, onBack }: PlaceChooserProps) {
  const { place, repoId } = chooser;
  const heroesHere = agents.filter((a) => {
    const r = resolveAgentPlace(a);
    return r ? r.place.id === place.id : place.id === TAVERN_PLACE.id;
  });

  return (
    <div className="drawer-chooser">
      <div className="drawer-chooser-kicker">Start a quest in</div>
      <h2 className="drawer-chooser-title">{place.name}</h2>
      <p className="drawer-chooser-tagline">{place.tagline}</p>

      <ul className="drawer-chooser-list">
        {launchTargets(place).map((r) => (
          <li key={r.id} className={`drawer-chooser-item ${r.id === repoId ? 'drawer-chooser-item-hint' : ''}`}>
            <div className="drawer-chooser-repo">
              <span className="drawer-chooser-name">{r.name}</span>
              <span className="drawer-chooser-cwd" title={r.cwd}>
                {r.cwd}
              </span>
            </div>
            <div className="drawer-chooser-btns">
              <button type="button" className="drawer-btn drawer-btn-primary" onClick={() => onLaunch(r, 'new')}>
                ✦ New session
              </button>
              <button type="button" className="drawer-btn" onClick={() => onLaunch(r, 'shell')}>
                $ Shell
              </button>
            </div>
          </li>
        ))}
      </ul>

      {heroesHere.length > 0 && (
        <div className="drawer-chooser-heroes">
          <div className="drawer-chooser-sub">Heroes already here</div>
          <div className="drawer-chooser-chips">
            {heroesHere.map((a) => (
              <button
                key={a.sessionId}
                type="button"
                className="drawer-chip"
                style={{ borderColor: heroColor(a.sessionId) }}
                onClick={() => onResume(a)}
                title={`Resume ${a.shortId}`}
              >
                <span className="drawer-chip-dot" style={{ background: heroColor(a.sessionId) }} />
                {agentName(a)}
              </button>
            ))}
          </div>
        </div>
      )}

      {hasTabs && (
        <button type="button" className="drawer-btn drawer-btn-ghost drawer-chooser-back" onClick={onBack}>
          ← Back to terminals
        </button>
      )}
    </div>
  );
}
