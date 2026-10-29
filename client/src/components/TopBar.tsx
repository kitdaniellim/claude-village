// Top bar as a game HUD: left = title + connection pill, centre = status
// counts, right = tools (day/night, sound | activity, backpack, war |
// editor, restart/reload, settings popover: canvas, desktop, sound, shortcuts, about).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { AgentState, ConnectionStatus } from '../types/agent';
import type { DesktopSettingsControl } from '../hooks/useDesktopSettings';
import type { FeedMode } from '../hooks/useFeedDock';
import { SHORTCUTS } from '../hooks/useKeyboardShortcuts';
import { STATUS_COLORS } from '../utils/spriteMapper';
import { CREDITS, creditLine } from '../utils/credits';
import { BagIcon, CrossedSwordsIcon, PixelIcon, WarIcon } from './PixelIcon';
import type { PixelIconName } from './PixelIcon';
import './TopBar.css';

export interface TopBarProps {
  connection: ConnectionStatus;
  agents: AgentState[];
  night: boolean;
  onToggleNight: () => void;
  editor: boolean;
  onToggleEditor: () => void;
  scaleMode: 'fit' | '2x';
  onScaleMode: (mode: 'fit' | '2x') => void;
  showGrid: boolean;
  onShowGrid: (show: boolean) => void;
  sound: boolean;
  onToggleSound: () => void;
  desktop: DesktopSettingsControl;
  feedMode: FeedMode;
  /** Events that arrived while the dock was collapsed or closed. */
  feedUnread: number;
  onToggleFeed: () => void;
  rewardsOpen: boolean;
  onToggleRewards: () => void;
  /** Rewards in the backpack quest log (badge). */
  itemCount: number;
  /** Bumps per award — the backpack bounces once. */
  awardNonce: number;
  /** WAR: every idle villager spreads out to fight the monsters (pure visual, no session input). */
  war: boolean;
  onToggleWar: () => void;
}

/** Handled by the desktop main process (before-input-event); a plain browser hard-reloads natively. */
const RESTART_SHORTCUT = { keys: 'Ctrl + Shift + R', what: 'Restart village / reload' };

const CONN_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  online: 'Online',
  offline: 'Reconnecting',
  'server-shutdown': 'Offline',
};

interface HudButtonProps {
  /** A glyph name, or a ready element for bitmap icons (the bag). */
  icon: PixelIconName | ReactElement;
  title: string;
  onClick: () => void;
  active?: boolean;
  muted?: boolean;
  /** Corner badge; hidden when null or 0. */
  badge?: number | null;
  bump?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  /** Lets the rewards panel ignore outside-clicks on its own toggles. */
  rewardsToggle?: boolean;
}

function HudButton(p: HudButtonProps) {
  const cls = [
    'ui-btn',
    'ui-btn-icon',
    'topbar-btn',
    p.active ? 'ui-btn-active' : '',
    p.muted ? 'topbar-btn-muted' : '',
    p.bump ? 'topbar-btn-bump' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      onClick={p.onClick}
      title={p.title}
      aria-label={p.title}
      aria-pressed={p.pressed}
      aria-expanded={p.expanded}
      data-rewards-toggle={p.rewardsToggle ? '' : undefined}
    >
      {typeof p.icon === 'string' ? <PixelIcon name={p.icon} /> : p.icon}
      {p.badge ? <span className="ui-badge">{p.badge > 99 ? '99+' : p.badge}</span> : null}
    </button>
  );
}

export default function TopBar(props: TopBarProps) {
  const {
    connection,
    agents,
    night,
    onToggleNight,
    editor,
    onToggleEditor,
    scaleMode,
    onScaleMode,
    showGrid,
    onShowGrid,
    sound,
    onToggleSound,
    desktop,
    feedMode,
    feedUnread,
    onToggleFeed,
    rewardsOpen,
    onToggleRewards,
    itemCount,
    awardNonce,
    war,
    onToggleWar,
  } = props;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const [bump, setBump] = useState(false);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent): void => {
      const root = settingsRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setSettingsOpen(false);
      }
    };
    // Capture phase + preventDefault so Esc closes only the popover, not the drawer too.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSettingsOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [settingsOpen]);

  // New item → the backpack hops once.
  useEffect(() => {
    if (awardNonce === 0) return;
    setBump(true);
    const id = window.setTimeout(() => setBump(false), 700);
    return () => window.clearTimeout(id);
  }, [awardNonce]);

  const active = agents.filter(
    (a) => a.status === 'thinking' || a.status === 'running' || a.status === 'delegating'
  ).length;
  const idle = agents.filter((a) => a.status === 'idle').length;
  const done = agents.filter((a) => a.status === 'done').length;
  const errors = agents.filter((a) => a.status === 'error').length;

  const offline = connection === 'offline' || connection === 'server-shutdown';
  const hasBridge = desktop.bridge !== null;
  const desktopReady = hasBridge && desktop.settings !== null;
  // An older preload (app not relaunched since the update) has no restart(); reload instead.
  const restart = desktop.bridge && typeof desktop.bridge.restart === 'function' ? desktop.bridge.restart : null;

  return (
    <div className="topbar-wrap">
      <header className="topbar">
        <div className="topbar-left">
          <span className="topbar-logo" aria-hidden="true">
            <CrossedSwordsIcon />
          </span>
          <h1 className="topbar-title">RTS Agents</h1>
          <span className={`topbar-conn topbar-conn-${connection}`} role="status">
            <span className="topbar-conn-dot" />
            {CONN_LABEL[connection]}
          </span>
        </div>

        <div className="topbar-counts" role="group" aria-label="Party status">
          <span className={`topbar-count ${active > 0 ? 'topbar-count-live' : ''}`}>
            <span className="topbar-count-dot" style={{ background: STATUS_COLORS.running }} />
            Active <b>{active}</b>
          </span>
          <span className="topbar-count">
            <span className="topbar-count-dot" style={{ background: STATUS_COLORS.idle }} />
            Idle <b>{idle}</b>
          </span>
          <span className="topbar-count">
            <span className="topbar-count-dot" style={{ background: STATUS_COLORS.done }} />
            Done <b>{done}</b>
          </span>
          {errors > 0 && (
            <span className="topbar-count topbar-count-error">
              <span className="topbar-count-dot" style={{ background: STATUS_COLORS.error }} />
              Errors <b>{errors}</b>
            </span>
          )}
          <span className="topbar-count topbar-count-total">
            Total <b>{agents.length}</b>
          </span>
        </div>

        <div className="topbar-right">
          <div className="topbar-group">
            <HudButton
              icon={night ? 'moon' : 'sun'}
              title={night ? 'Switch to day' : 'Switch to night'}
              onClick={onToggleNight}
            />
            <HudButton
              icon={sound ? 'bell' : 'bell-off'}
              title={sound ? 'Mute sound cues (M)' : 'Unmute sound cues (M)'}
              onClick={onToggleSound}
              muted={!sound}
              pressed={!sound}
            />
          </div>
          <span className="ui-sep" aria-hidden="true" />
          <div className="topbar-group">
            <HudButton
              icon="feed"
              title={feedMode === 'closed' ? 'Show activity feed' : 'Hide activity feed'}
              onClick={onToggleFeed}
              active={feedMode !== 'closed'}
              badge={feedMode !== 'open' ? feedUnread : null}
              pressed={feedMode !== 'closed'}
            />
            {/* The bag opens (flap + sparkle) while its panel is showing. */}
            <HudButton
              icon={<BagIcon open={rewardsOpen} />}
              title={`Backpack — quest log, ${itemCount} reward${itemCount === 1 ? '' : 's'} (B)`}
              onClick={onToggleRewards}
              active={rewardsOpen}
              expanded={rewardsOpen}
              badge={itemCount}
              bump={bump}
              rewardsToggle
            />
            {/* Swords stand side by side at peace and cross when the host marches. */}
            <HudButton
              icon={<WarIcon war={war} />}
              title={war ? 'WAR — the host is fighting; click for peace' : 'Peace — click to send every idle villager to war'}
              onClick={onToggleWar}
              active={war}
              pressed={war}
            />
          </div>
          <span className="ui-sep" aria-hidden="true" />
          <div className="topbar-group">
            <HudButton icon="hammer" title="Toggle map editor" onClick={onToggleEditor} active={editor} pressed={editor} />
            <HudButton
              icon="restart"
              title={restart ? 'Restart RTS Agents (reloads the shell, server and map)' : 'Reload page'}
              onClick={() => (restart ? restart() : window.location.reload())}
            />
            <div className="topbar-settings" ref={settingsRef}>
              <HudButton
                icon="gear"
                title="Settings"
                onClick={() => setSettingsOpen((v) => !v)}
                active={settingsOpen}
                expanded={settingsOpen}
              />
              {settingsOpen && (
                <div className="topbar-popover" role="dialog" aria-label="Settings">
                  <div className="topbar-popover-title">Settings</div>

                  <div className="topbar-popover-row">
                    <span>Canvas scale</span>
                    <span className="topbar-popover-opts">
                      <label>
                        <input
                          type="radio"
                          name="scale"
                          checked={scaleMode === 'fit'}
                          onChange={() => onScaleMode('fit')}
                        />
                        fit
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="scale"
                          checked={scaleMode === '2x'}
                          onChange={() => onScaleMode('2x')}
                        />
                        2x
                      </label>
                    </span>
                  </div>
                  <div className="topbar-popover-row">
                    <span>Show grid</span>
                    <label>
                      <input type="checkbox" checked={showGrid} onChange={(e) => onShowGrid(e.target.checked)} />
                    </label>
                  </div>

                  <div className="topbar-popover-section">
                    Desktop
                    {!hasBridge && <span className="topbar-popover-note">desktop app only</span>}
                  </div>
                  <div className={`topbar-popover-row ${desktopReady ? '' : 'topbar-popover-row-disabled'}`}>
                    <span>Launch on startup</span>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!desktopReady}
                        checked={desktop.settings?.openAtLogin ?? false}
                        onChange={(e) => desktop.update({ openAtLogin: e.target.checked })}
                      />
                    </label>
                  </div>
                  <div className={`topbar-popover-row ${desktopReady ? '' : 'topbar-popover-row-disabled'}`}>
                    <span>Start minimised</span>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!desktopReady}
                        checked={desktop.settings?.startMinimized ?? false}
                        onChange={(e) => desktop.update({ startMinimized: e.target.checked })}
                      />
                    </label>
                  </div>

                  <div className="topbar-popover-section">Sound</div>
                  <div className="topbar-popover-row">
                    <span>Sound cues</span>
                    <label>
                      <input type="checkbox" checked={sound} onChange={onToggleSound} />
                    </label>
                  </div>

                  <div className="topbar-popover-section">Shortcuts</div>
                  <ul className="topbar-shortcuts">
                    {[...SHORTCUTS, RESTART_SHORTCUT].map((s) => (
                      <li key={s.keys}>
                        <span>{s.what}</span>
                        <kbd className="ui-kbd">{s.keys}</kbd>
                      </li>
                    ))}
                  </ul>

                  <div className="topbar-popover-section">About</div>
                  <div className="topbar-popover-about">
                    {desktop.bridge
                      ? `RTS Agents ${desktop.bridge.versions.app} · Electron ${desktop.bridge.versions.electron} · Node ${desktop.bridge.versions.node}`
                      : 'RTS Agents · browser build'}
                  </div>
                  {/* CC-BY / CC-BY-SA packs need visible attribution — one row per asset pack. */}
                  {CREDITS.map((c) => (
                    <div key={c.url} className="topbar-popover-about" title={creditLine(c)}>
                      {c.asset.split(' — ')[0]} by{' '}
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.author.split(',')[0]}
                      </a>{' '}
                      ({c.license})
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      {offline && (
        <div className="topbar-offline-banner" role="alert">
          {connection === 'server-shutdown' ? 'Server shut down — retrying…' : 'Server offline — retrying…'}
        </div>
      )}
    </div>
  );
}
