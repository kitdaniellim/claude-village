// Browser fallback for a terminal tab: a parchment scroll explaining that
// terminals need the desktop app, with copyable cwd and resume command.

import { useEffect, useRef, useState } from 'react';
import { manualCommand } from '../utils/terminalTabs';
import type { TerminalTab } from '../utils/terminalTabs';

interface TerminalNoticeProps {
  tab: TerminalTab;
}

async function copyText(value: string): Promise<boolean> {
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
        {cmd && <CopyRow label={tab.kind === 'resume' ? 'Resume' : 'Start'} value={cmd} />}
        {!cmd && <p className="notice-foot">Open any shell in the folder above.</p>}
      </div>
    </div>
  );
}
