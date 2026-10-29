// Top bar: title + connection indicator, status counts, day/night, editor,
// sound mute and the settings popover (canvas, desktop, sound, shortcuts, about).

import { useEffect, useRef, useState } from 'react';
import type { AgentState, ConnectionStatus } from '../types/agent';
import type { DesktopSettingsControl } from '../hooks/useDesktopSettings';
import { SHORTCUTS } from '../hooks/useKeyboardShortcuts';
import { STATUS_COLORS } from '../utils/spriteMapper';
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
}

const CONN_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  online: 'Online',
  offline: 'Reconnecting',
  'server-shutdown': 'Offline',
};

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
  } = props;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);

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

  const active = agents.filter((a) => a.status === 'thinking' || a.status === 'running').length;
  const idle = agents.filter((a) => a.status === 'idle').length;
  const done = agents.filter((a) => a.status === 'done').length;
  const errors = agents.filter((a) => a.status === 'error').length;

  const offline = connection === 'offline' || connection === 'server-shutdown';
  const hasBridge = desktop.bridge !== null;
  const desktopReady = hasBridge && desktop.settings !== null;

  return (
    <div className="topbar-wrap">
      <header className="topbar">
        <div className="topbar-left">
          <span className="topbar-logo" aria-hidden="true">
            ⚔
          </span>
          <h1 className="topbar-title">RTS Agents</h1>
          <span className={`topbar-conn topbar-conn-${connection}`}>
            <span className="topbar-conn-dot" />
            {CONN_LABEL[connection]}
          </span>
        </div>

        <div className="topbar-counts">
          <span className="topbar-count">
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
          <button
            type="button"
            className="topbar-btn"
            onClick={onToggleNight}
            title={night ? 'Switch to day' : 'Switch to night'}
          >
            {night ? '☾' : '☀'}
          </button>
          <button
            type="button"
            className={`topbar-btn ${sound ? '' : 'topbar-btn-muted'}`}
            onClick={onToggleSound}
            title={sound ? 'Mute sound cues (M)' : 'Unmute sound cues (M)'}
            aria-pressed={!sound}
          >
            {sound ? '🔔' : '🔕'}
          </button>
          <button
            type="button"
            className={`topbar-btn ${editor ? 'topbar-btn-active' : ''}`}
            onClick={onToggleEditor}
            title="Toggle map editor"
          >
            ⚒
          </button>
          <div className="topbar-settings" ref={settingsRef}>
            <button
              type="button"
              className={`topbar-btn ${settingsOpen ? 'topbar-btn-active' : ''}`}
              onClick={() => setSettingsOpen((v) => !v)}
              title="Settings"
              aria-expanded={settingsOpen}
            >
              ⚙
            </button>
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
                    <input
                      type="checkbox"
                      checked={showGrid}
                      onChange={(e) => onShowGrid(e.target.checked)}
                    />
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
                  {SHORTCUTS.map((s) => (
                    <li key={s.keys}>
                      <span>{s.what}</span>
                      <kbd>{s.keys}</kbd>
                    </li>
                  ))}
                </ul>

                <div className="topbar-popover-section">About</div>
                <div className="topbar-popover-about">
                  {desktop.bridge
                    ? `RTS Agents ${desktop.bridge.versions.app} · Electron ${desktop.bridge.versions.electron} · Node ${desktop.bridge.versions.node}`
                    : 'RTS Agents · browser build'}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>
      {offline && (
        <div className="topbar-offline-banner">
          {connection === 'server-shutdown'
            ? 'Server shut down — retrying…'
            : 'Server offline — retrying…'}
        </div>
      )}
    </div>
  );
}
