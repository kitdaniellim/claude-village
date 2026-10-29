// Parchment notices in a terminal pane: the browser fallback (terminals need
// the desktop app; copyable cwd + command) and "this session's history is gone".

import { useEffect, useRef, useState } from 'react';
import { manualCommand } from '../utils/terminalTabs';
import type { TerminalTab } from '../utils/terminalTabs';

interface TerminalNoticeProps {
  tab: TerminalTab;
}

/** Clipboard write with an execCommand fallback (older shells, unfocused documents). */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onCopy = async (): Promise<void> => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1400);
  };

  return (
    <div className="notice-row">
      <span className="notice-label">{label}</span>
      <code className="notice-code" title={value}>
        {value}
      </code>
      <button
        type="button"
        className={`drawer-btn notice-copy ${state === 'copied' ? 'notice-copy-done' : ''}`}
        onClick={() => void onCopy()}
      >
        {state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Select & copy' : 'Copy'}
      </button>
    </div>
  );
}

export default function TerminalNotice({ tab }: TerminalNoticeProps) {
  const cmd = manualCommand(tab);
  return (
    <div className="notice">
      <div className="notice-scroll">
        <div className="notice-kicker">Hark, traveller</div>
        <h3 className="notice-title">Terminals live in the desktop app</h3>
        <p className="notice-text">
          Launch the desktop build and <b>{tab.name}</b> opens right here as a live terminal.
          Until then, here is everything you need to do it by hand.
        </p>
        <CopyRow label="Desktop app" value="bun run desktop" />
        <CopyRow label="Folder" value={tab.cwd} />
        <CopyRow label={tab.kind === 'resume' ? 'Resume' : tab.kind === 'fork' ? 'Fork' : 'Start'} value={cmd} />
      </div>
    </div>
  );
}

interface MissingHistoryNoticeProps {
  tab: TerminalTab;
  onNewSession: () => void;
  onClose: () => void;
}

/** Shown instead of a dead `claude --resume` whose transcript isn't on disk. */
export function MissingHistoryNotice({ tab, onNewSession, onClose }: MissingHistoryNoticeProps) {
  return (
    <div className="notice">
      <div className="notice-scroll" role="alert">
        <div className="notice-kicker">The scroll is blank</div>
        <h3 className="notice-title">This session&apos;s history isn&apos;t on disk</h3>
        <p className="notice-text">
          <b>{tab.name}</b> can&apos;t be resumed — it may have been started without saving. Start a new session
          here instead?
        </p>
        <CopyRow label="Folder" value={tab.cwd} />
        <div className="notice-actions">
          <button type="button" className="drawer-btn drawer-btn-primary" onClick={onNewSession}>
            ✦ New session here
          </button>
          <button type="button" className="drawer-btn notice-btn-plain" onClick={onClose}>
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
