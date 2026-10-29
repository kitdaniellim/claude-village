// Terminal tab model shared by the drawer, the xterm view and the browser
// notice: what to launch, where, and how to describe it.

import type { PtyOpenOptions } from '../types/desktop';
import { resumeCommand } from './agentLabel';

export type TerminalKind = 'resume' | 'new' | 'shell';

export interface TerminalTab {
  id: string;
  kind: TerminalKind;
  /** Session this tab was opened from; null for place-chooser launches. */
  sessionId: string | null;
  name: string;
  shortId: string | null;
  cwd: string;
  /** Hero / place hue for the tab strip. */
  color: string;
}

export const KIND_GLYPH: Record<TerminalKind, string> = { resume: '↻', new: '✦', shell: '$' };
export const KIND_LABEL: Record<TerminalKind, string> = {
  resume: 'Resumed session',
  new: 'New session',
  shell: 'Shell',
};

let seq = 0;

/** Fresh id always wins — callers often spread an existing tab as the template. */
export function makeTab(init: Omit<TerminalTab, 'id'>): TerminalTab {
  seq += 1;
  return { ...init, id: `tab-${seq}-${Date.now().toString(36)}` };
}

/** Everything `pty.open` needs except the fitted cols/rows. */
export function launchOptions(
  tab: Pick<TerminalTab, 'kind' | 'sessionId' | 'cwd'>,
): Omit<PtyOpenOptions, 'cols' | 'rows'> {
  if (tab.kind === 'shell') return { cwd: tab.cwd, shell: true };
  if (tab.kind === 'resume' && tab.sessionId) return { cwd: tab.cwd, resumeSessionId: tab.sessionId };
  return { cwd: tab.cwd };
}

/** The command to type by hand when there is no desktop bridge ('' for a plain shell). */
export function manualCommand(tab: TerminalTab): string {
  if (tab.kind === 'shell') return '';
  if (tab.kind === 'resume' && tab.sessionId) return resumeCommand(tab.sessionId);
  return 'claude';
}
