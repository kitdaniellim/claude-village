// Terminal tab model shared by the drawer, the xterm view and the browser
// notice: what to launch, where, how to describe it, and what survives a restart.

import type { PtyOpenOptions } from '../types/desktop';
import { NAMELESS, forkCommand, newSessionCommand, resumeCommand } from './agentLabel';

/** resume = `claude --resume`; new = fresh `claude --name Nameless`; fork = a squire of `sessionId`. */
export type TerminalKind = 'resume' | 'new' | 'fork';

export interface TerminalTab {
  id: string;
  kind: TerminalKind;
  /** The hero (resume) or the parent being forked (fork); null for a fresh session until it appears. */
  sessionId: string | null;
  name: string;
  shortId: string | null;
  cwd: string;
  /** Hero / place hue for the tab strip. */
  color: string;
  /** Squire look (portrait pool, epithet): a fork tab or a resumed squire. */
  squire: boolean;
  /** "Take over here" on a session still running in another terminal (warning strip). */
  elsewherePid: number | null;
  /** The transcript isn't on disk, so resume can't work — show the "start fresh" parchment instead. */
  missing?: boolean;
  /** Epoch ms — launches adopt only heroes that appeared after they were opened. */
  createdAt: number;
  /** The session's launch dir as the server reported it (resume runs from here). */
  rootCwd?: string | null;
  /** Reopened after an app restart and not focused since: no pty until it is woken. */
  restored?: boolean;
  /** Epoch ms a launch tab was adopted by its hero (drives the one-shot auto-select). */
  adoptedAt?: number;
}

export const KIND_GLYPH: Record<TerminalKind, string> = { resume: '↻', new: '✦', fork: '⚔' };
export const KIND_LABEL: Record<TerminalKind, string> = {
  resume: 'Resumed session',
  new: 'New session',
  fork: 'Forked squire',
};

let seq = 0;

/** Fresh id always wins — callers often spread an existing tab as the template. */
export function makeTab(init: Omit<TerminalTab, 'id' | 'createdAt'>): TerminalTab {
  seq += 1;
  return { ...init, id: `tab-${seq}-${Date.now().toString(36)}`, createdAt: Date.now() };
}

// ── Restart persistence (desktop only) ──────────────────────────────────────

export const TABS_STORAGE_KEY = 'rts-agents.tabs.v1';

/** What survives a restart: the launch recipe of each tab, never its pty id or pid. */
export interface PersistedTab {
  id: string;
  kind: TerminalKind;
  sessionId: string | null;
  name: string;
  cwd: string;
  rootCwd: string | null;
  color: string;
  squire: boolean;
}

export interface PersistedTabs {
  v: 1;
  savedAt: number;
  tabs: PersistedTab[];
  activeId: string | null;
  drawerOpen: boolean;
}

/** A resumed tab's hero, for a party placeholder while the server doesn't list it. */
export interface SleepingHero {
  sessionId: string;
  name: string;
  cwd: string;
  rootCwd: string | null;
  squire: boolean;
  /** Restored and not started yet (false = its claude is starting up). */
  asleep: boolean;
  /** A Create Party / Fetch Squire launch whose hero hasn't appeared yet (sessionId is `tab:<id>`). */
  launching?: boolean;
}

const KINDS: readonly string[] = ['resume', 'new', 'fork'];

/** Parse + validate a stored blob; null when absent or malformed. */
export function parsePersistedTabs(raw: string | null | undefined): PersistedTabs | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r['v'] !== 1 || !Array.isArray(r['tabs'])) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const tabs: PersistedTab[] = [];
  for (const t of r['tabs'] as unknown[]) {
    if (!t || typeof t !== 'object') continue;
    const x = t as Record<string, unknown>;
    const id = str(x['id']);
    const kind = str(x['kind']);
    const cwd = str(x['cwd']);
    if (!id || !kind || !KINDS.includes(kind) || !cwd) continue;
    const sessionId = str(x['sessionId']);
    if (sessionId !== null && !/^[\w-]+$/.test(sessionId)) continue;
    tabs.push({
      id,
      kind: kind as TerminalKind,
      sessionId,
      name: str(x['name']) ?? NAMELESS,
      cwd,
      rootCwd: str(x['rootCwd']),
      color: str(x['color']) ?? '#6b7280',
      squire: x['squire'] === true,
    });
  }
  return {
    v: 1,
    savedAt: typeof r['savedAt'] === 'number' ? r['savedAt'] : 0,
    tabs,
    activeId: str(r['activeId']),
    drawerOpen: r['drawerOpen'] === true,
  };
}

/** Snapshot of the drawer for storage (rootCwd falls back to the live hero's). */
export function snapshotTabs(
  tabs: TerminalTab[],
  activeId: string | null,
  drawerOpen: boolean,
  rootCwdOf: (sessionId: string) => string | null,
): PersistedTabs {
  return {
    v: 1,
    savedAt: Date.now(),
    tabs: tabs.map((t) => ({
      id: t.id,
      kind: t.kind,
      sessionId: t.sessionId,
      name: t.name,
      cwd: t.cwd,
      rootCwd: t.rootCwd ?? (t.kind === 'resume' && t.sessionId ? rootCwdOf(t.sessionId) : null),
      color: t.color,
      squire: t.squire,
    })),
    activeId: tabs.some((t) => t.id === activeId) ? activeId : null,
    drawerOpen,
  };
}

/** Back to dormant tabs: known sessions resume, never-created ones relaunch in their folder. */
export function restoreTabs(saved: PersistedTabs): TerminalTab[] {
  const now = Date.now();
  return saved.tabs.map((p) => {
    // A fresh launch whose session never appeared starts over as Nameless; an unadopted fork forks again.
    const kind: TerminalKind = p.kind === 'fork' && p.sessionId ? 'fork' : p.sessionId ? 'resume' : 'new';
    return {
      id: p.id,
      kind,
      sessionId: kind === 'new' ? null : p.sessionId,
      name: kind === 'new' ? NAMELESS : p.name,
      shortId: kind === 'resume' && p.sessionId ? p.sessionId.slice(0, 8) : null,
      cwd: p.cwd,
      rootCwd: p.rootCwd,
      color: p.color,
      squire: kind === 'new' ? false : p.squire,
      elsewherePid: null,
      createdAt: now,
      restored: true,
    };
  });
}

/** Everything `pty.open` needs except the fitted cols/rows. */
export function launchOptions(
  tab: Pick<TerminalTab, 'kind' | 'sessionId' | 'cwd' | 'name'>,
): Omit<PtyOpenOptions, 'cols' | 'rows'> {
  if (tab.kind === 'fork' && tab.sessionId) {
    return { cwd: tab.cwd, resumeSessionId: tab.sessionId, fork: true, name: tab.name };
  }
  if (tab.kind === 'resume' && tab.sessionId) return { cwd: tab.cwd, resumeSessionId: tab.sessionId };
  return { cwd: tab.cwd, name: tab.name.trim() || NAMELESS };
}

/** The command to type by hand when there is no desktop bridge. */
export function manualCommand(tab: TerminalTab): string {
  if (tab.kind === 'fork' && tab.sessionId) return forkCommand(tab.sessionId, tab.name);
  if (tab.kind === 'resume' && tab.sessionId) return resumeCommand(tab.sessionId);
  return newSessionCommand();
}

/** Claude's per-project transcript folder name: every non-alphanumeric becomes "-". */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

/** Of the candidate dirs, the one whose transcript folder is `projectDir` (null = none match). */
export function cwdForProject(candidates: (string | null)[], projectDir: string): string | null {
  const want = projectDir.toLowerCase();
  return candidates.find((c): c is string => !!c && projectSlug(c).toLowerCase() === want) ?? null;
}

/** ANSI/OSC escapes out, whitespace collapsed — enough to pattern-match terminal output. */
export function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\s+/g, ' ');
}

/** `claude --resume <id>` printed that this session's transcript can't be found (id must match too). */
export function isMissingConversation(text: string, sessionId: string): boolean {
  const flat = plainText(text);
  const m = /No conversation found with session ID:?\s*([\w-]+)/i.exec(flat);
  return !!m && m[1] === sessionId;
}

/** Blocked label on a session (UI only — the terminal is untouched). */
export interface BlockedMark {
  note: string;
  at: number;
}

/** sessionId → blocked mark. */
export type BlockedMap = Record<string, BlockedMark>;

/** Notes are short reminders; caps keep the saved map inside the prefs backup's size limit. */
export const BLOCKED_NOTE_MAX = 240;
export const BLOCKED_MAX = 12;

export function isBlockedMap(v: unknown): v is BlockedMap {
  return (
    !!v &&
    typeof v === 'object' &&
    Object.values(v as object).every(
      (m) => !!m && typeof m === 'object' && typeof (m as BlockedMark).note === 'string' && typeof (m as BlockedMark).at === 'number',
    )
  );
}
