// One xterm.js terminal bound to a window.rts pty: spawns at the fitted size,
// pipes keystrokes/output both ways, refits on resize, and shows an "exited"
// overlay with Restart when the process ends.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { DesktopBridge } from '../types/desktop';
import { launchOptions } from '../utils/terminalTabs';
import type { TerminalTab } from '../utils/terminalTabs';
import '@xterm/xterm/css/xterm.css';

export interface XtermViewProps {
  bridge: DesktopBridge;
  tab: TerminalTab;
  active: boolean;
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

export default function XtermView({ bridge, tab, active }: XtermViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const { kind, sessionId, cwd } = tab;

  // Terminal lifecycle — once per mount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      theme: THEME,
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => bridge.openExternal(uri)));
    term.open(host);

    // Skip fitting while hidden (inactive tab / closed drawer) — it would shrink the pty to nothing.
    const safeFit = (): void => {
      if (host.clientWidth < 60 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        // not measurable yet
      }
    };
    termRef.current = term;
    fitRef.current = safeFit;
    safeFit();

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(host);

    const dataSub = term.onData((d) => {
      const id = ptyIdRef.current;
      if (id) bridge.pty.write(id, d);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      const id = ptyIdRef.current;
      if (id) bridge.pty.resize(id, cols, rows);
    });

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
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
    if (generation > 0) term.reset();
    fitRef.current?.();

    const opts = { ...launchOptions({ kind, sessionId, cwd }), cols: term.cols, rows: term.rows };
    bridge.pty
      .open(opts)
      .then((h) => {
        if (disposed) {
          bridge.pty.close(h.id);
          return;
        }
        id = h.id;
        ptyIdRef.current = h.id;
        unsubData = bridge.pty.onData(h.id, (d) => term.write(d));
        unsubExit = bridge.pty.onExit(h.id, (code) => {
          id = null;
          ptyIdRef.current = null;
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

    return () => {
      disposed = true;
      unsubData?.();
      unsubExit?.();
      if (id) bridge.pty.close(id);
      ptyIdRef.current = null;
    };
  }, [bridge, kind, sessionId, cwd, generation]);

  // Becoming the visible tab: refit (size may have changed while hidden) and take focus.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className="xterm-wrap">
      <div className="xterm-host" ref={hostRef} />
      {exitCode !== null && (
        <div className="xterm-exit">
          <span className="xterm-exit-text">exited (code {exitCode})</span>
          <button
            type="button"
            className="drawer-btn drawer-btn-primary"
            onClick={() => setGeneration((g) => g + 1)}
          >
            ↻ Restart
          </button>
        </div>
      )}
    </div>
  );
}
