// One xterm.js terminal bound to a window.rts pty: spawns at the fitted size,
// pipes keystrokes/output both ways, refits on every resize, copy-on-select +
// Ctrl+Shift+C/V, spots "No conversation found" on resume, and shows a
// "Session ended" overlay (Restart / Close) over dimmed scrollback once it exits.

import { TYPING_EVENT } from '../utils/typing';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { DesktopBridge } from '../types/desktop';
import { isMissingConversation, launchOptions } from '../utils/terminalTabs';
import type { TerminalTab } from '../utils/terminalTabs';
import { copyText } from './TerminalNotice';
import '@xterm/xterm/css/xterm.css';

export interface XtermViewProps {
  bridge: DesktopBridge;
  tab: TerminalTab;
  active: boolean;
  /** The spawned process pid (null once it exits) — lets the drawer recognise its own sessions. */
  onPid?: (pid: number | null) => void;
  /** Resume failed because the transcript is missing; the drawer swaps in a parchment. */
  onMissing?: () => void;
  /** "Close" on the ended overlay — the drawer drops this tab. */
  onClose?: () => void;
}

const THEME: ITheme = {
  background: '#0d1018',
  foreground: '#e3dcc6',
  cursor: '#ffd97a',
  cursorAccent: '#0d1018',
  selectionBackground: 'rgba(255, 217, 122, 0.28)',
  black: '#1b2133',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#a78bfa',
  cyan: '#3fc1c9',
  white: '#cfd6e6',
  brightBlack: '#6e7794',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#c4b5fd',
  brightCyan: '#7ee3ea',
  brightWhite: '#f2e6c0',
};

const FONT = "'Cascadia Mono', 'Consolas', 'JetBrains Mono', 'Menlo', 'Courier New', monospace";
/** Narrow drawers get 13 px so Claude's UI keeps ~70 columns; wider ones 14 px. */
const NARROW_PX = 760;
const fontSizeFor = (w: number): number => (w < NARROW_PX ? 13 : 14);

/** Ctrl+Shift+<key> with no Alt/Meta. */
function ctrlShift(e: KeyboardEvent, code: string): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === code;
}

export default function XtermView({ bridge, tab, active, onPid, onMissing, onClose }: XtermViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const restartRef = useRef<HTMLButtonElement | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  // Read at spawn time only: a launch tab turning into its hero's resume tab must not respawn
  // the live process, while a later Restart resumes that hero instead of launching anew.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const cbRef = useRef({ onPid, onMissing });
  cbRef.current = { onPid, onMissing };

  // Terminal lifecycle — once per mount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: THEME,
      fontFamily: FONT,
      fontSize: fontSizeFor(host.clientWidth || 800),
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => bridge.openExternal(uri)));
    term.open(host);

    // Skip fitting while hidden (inactive tab / closed drawer) — it would shrink the pty to nothing.
    const safeFit = (): void => {
      if (host.clientWidth < 60 || host.clientHeight < 40) return;
      const size = fontSizeFor(host.clientWidth);
      if (term.options.fontSize !== size) term.options.fontSize = size;
      try {
        fit.fit();
      } catch {
        // not measurable yet
      }
    };
    termRef.current = term;
    fitRef.current = safeFit;
    safeFit();
    // Cell metrics change once the web font lands; refit so the last column/row isn't clipped.
    void document.fonts?.ready.then(() => {
      if (termRef.current === term) safeFit();
    });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(host);

    const copySelection = (): void => {
      const sel = term.getSelection();
      if (!sel) return;
      const hadFocus = host.contains(document.activeElement);
      void copyText(sel).then(() => {
        if (hadFocus) term.focus(); // the execCommand fallback borrows focus
      });
    };

    // Ctrl+Shift+C/V copy/paste; Ctrl+Shift+F is the app's focus-mode toggle, not a terminal key.
    term.attachCustomKeyEventHandler((e) => {
      if (ctrlShift(e, 'KeyF')) return false;
      if (ctrlShift(e, 'KeyC')) {
        if (e.type === 'keydown') copySelection();
        e.preventDefault();
        return false;
      }
      if (ctrlShift(e, 'KeyV')) {
        if (e.type === 'keydown') {
          void navigator.clipboard
            ?.readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch(() => {
              // clipboard read refused — the native Ctrl+V / right-click paste still works
            });
        }
        e.preventDefault();
        return false;
      }
      return true;
    });

    // Copy-on-select, debounced so a drag doesn't write the clipboard on every cell.
    let selTimer: number | undefined;
    const selSub = term.onSelectionChange(() => {
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(() => {
        if (term.hasSelection()) copySelection();
      }, 200);
    });
    const dataSub = term.onData((d) => {
      const id = ptyIdRef.current;
      if (id) bridge.pty.write(id, d);
      // Tell the village this hero's player is typing (Enter = sent, stops the dots).
      const sid = tabRef.current.sessionId;
      if (sid) window.dispatchEvent(new CustomEvent(TYPING_EVENT, { detail: { sessionId: sid, sent: d.includes('\r') } }));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      const id = ptyIdRef.current;
      if (id) bridge.pty.resize(id, cols, rows);
    });

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(selTimer);
      selSub.dispose();
      dataSub.dispose();
      resizeSub.dispose();
      termRef.current = null;
      fitRef.current = null;
      // xterm flushes queued writes on a later tick; disposing synchronously makes that
      // flush hit a torn-down renderer ("reading 'dimensions'"). Let it drain first.
      window.setTimeout(() => term.dispose(), 0);
    };
  }, [bridge]);

  // Process lifecycle — re-runs on Restart (generation bump).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let disposed = false;
    let id: string | null = null;
    let unsubData: (() => void) | null = null;
    let unsubExit: (() => void) | null = null;

    setExitCode(null);
    if (generation > 0) {
      term.reset();
      term.focus();
    }
    fitRef.current?.();

    // Keyed by tab id: after a page reload the main process hands back the claude that kept running.
    const opts = { ...launchOptions(tabRef.current), key: tabRef.current.id, cols: term.cols, rows: term.rows };
    // Only a resume/fork can fail with a missing transcript, and only at startup (first 20 s);
    // keep a short tail so the message matches across chunks.
    const resumeId = opts.resumeSessionId ?? null;
    const watchUntil = Date.now() + 20_000;
    let tail: string | null = resumeId ? '' : null;
    // Spawn on the next tick: React StrictMode (dev) mounts effects twice, and an immediate
    // open would start a second claude that is killed at once and lingers as a phantom hero.
    const spawnTimer = window.setTimeout(() => {
      if (disposed) return;
      bridge.pty
        .open(opts)
        .then((h) => {
          if (disposed) {
            bridge.pty.close(h.id);
            return;
          }
          id = h.id;
          ptyIdRef.current = h.id;
          cbRef.current.onPid?.(typeof h.pid === 'number' ? h.pid : null);
          if (typeof h.replay === 'string') {
            // Reattached: repaint what the screen showed, and skip the startup missing-history watch.
            term.reset();
            term.write(h.replay);
            tail = null;
          }
          unsubData = bridge.pty.onData(h.id, (d) => {
            term.write(d);
            if (tail === null || resumeId === null) return;
            if (Date.now() > watchUntil) {
              tail = null;
              return;
            }
            tail = (tail + d).slice(-600);
            if (isMissingConversation(tail, resumeId)) {
              tail = null;
              cbRef.current.onMissing?.();
            }
          });
          unsubExit = bridge.pty.onExit(h.id, (code) => {
            id = null;
            ptyIdRef.current = null;
            cbRef.current.onPid?.(null);
            term.blur();
            setExitCode(code);
          });
          // The drawer may have been resized while the process was spawning.
          if (term.cols !== opts.cols || term.rows !== opts.rows) bridge.pty.resize(h.id, term.cols, term.rows);
        })
        .catch((err: unknown) => {
          if (disposed) return;
          const msg = err instanceof Error ? err.message : String(err);
          term.writeln(`\r\n\x1b[31mcould not start: ${msg}\x1b[0m`);
          setExitCode(-1);
        });
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(spawnTimer);
      unsubData?.();
      unsubExit?.();
      if (id) bridge.pty.close(id);
      ptyIdRef.current = null;
      cbRef.current.onPid?.(null);
    };
  }, [bridge, generation]);

  // Becoming the visible tab: refit (size may have changed while hidden) and take focus.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.();
      if (exitCode === null) termRef.current?.focus();
      else restartRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, exitCode]);

  const ended = exitCode !== null;

  return (
    <div className={`xterm-wrap ${ended ? 'xterm-wrap-ended' : ''}`}>
      <div className="xterm-host" ref={hostRef} onMouseDown={() => !ended && termRef.current?.focus()} />
      {ended && (
        <div className="xterm-ended" role="alertdialog" aria-label="Session ended">
          <div className="xterm-ended-card">
            <div className="xterm-ended-kicker">The quest is over</div>
            <div className="xterm-ended-title">
              Session ended <span className="xterm-ended-code">(code {exitCode})</span>
            </div>
            <p className="xterm-ended-hint">
              {exitCode === 0 ? 'Claude exited cleanly.' : 'The process stopped — the log behind this card is from that run.'}
            </p>
            <div className="xterm-ended-btns">
              <button
                ref={restartRef}
                type="button"
                className="drawer-btn drawer-btn-primary"
                onClick={() => setGeneration((g) => g + 1)}
              >
                ↻ Restart
              </button>
              {onClose && (
                <button type="button" className="drawer-btn" onClick={onClose}>
                  Close tab
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
