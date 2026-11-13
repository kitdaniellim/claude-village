// Shared session labels: display name, "City · Repo" place line, cwd helpers,
// friendly activity verbs, relative time and the by-hand launch commands.

import type { AgentState } from '../types/agent';
import { CODING_ROOT, TAVERN_PLACE, resolveAgentPlace } from '../world/registry';

/** Where terminals start when a session never reported a cwd. */
export const FALLBACK_CWD = CODING_ROOT;

/** Every session the user hasn't /renamed; also the `--name` new sessions launch with. */
export const NAMELESS = 'Nameless';

/** The reviewer session: whoever carries this /rename name is the Party Leader. */
export const LEADER_NAME = 'PARTY LEADER';

export function isLeader(a: { customTitle: string | null }): boolean {
  return a.customTitle?.trim().toUpperCase() === LEADER_NAME;
}

/** Forked sessions are named "Squire of <parent>" (mirrors the server's SQUIRE_NAME_RE). */
export const SQUIRE_NAME_RE = /^Squire of (.+)$/;

type Named = Pick<AgentState, 'title' | 'customTitle'>;
type Placed = Pick<AgentState, 'cwd' | 'rootCwd' | 'title' | 'customTitle'>;

/** The user's /rename name wins; everyone else is Nameless (the AI title is secondary). */
export function agentName(a: Named): string {
  return a.customTitle?.trim() || NAMELESS;
}

/** The AI's auto title, when the hero has no name of its own to say it. */
export function agentSubtitle(a: Named): string | null {
  if (a.customTitle?.trim()) return null;
  return a.title?.trim() || null;
}

export function squireName(parentName: string): string {
  return `Squire of ${parentName}`;
}

/** "MY VILLAGE" from "Squire of MY VILLAGE"; null when the name isn't a squire name. */
export function squireParentName(name: string): string | null {
  return SQUIRE_NAME_RE.exec(name)?.[1] ?? null;
}

/** "SIF · FlashWorks", or just the place when it has no repo (tavern for unknowns). */
export function agentPlaceLabel(a: Placed): string {
  const r = resolveAgentPlace(a);
  if (!r) return TAVERN_PLACE.name;
  return r.repo && r.repo.name !== r.place.name ? `${r.place.name} · ${r.repo.name}` : r.place.name;
}

export function agentCwd(a: Pick<AgentState, 'cwd' | 'rootCwd'>): string {
  return a.cwd ?? a.rootCwd ?? FALLBACK_CWD;
}

/** Where `claude --resume` must run: the launch dir (transcripts are filed per launch project). */
export function resumeCwd(a: Pick<AgentState, 'cwd' | 'rootCwd'>): string {
  return a.rootCwd ?? a.cwd ?? FALLBACK_CWD;
}

/** "…\SIF FW\flashworks-framework-v2" — the last `keep` segments of a path. */
export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep + 1) return p;
  return `…\\${parts.slice(-keep).join('\\')}`;
}

/** Names a terminal tab would show for this session, best first (for "Go to terminal"). */
export function terminalTitles(a: Pick<AgentState, 'title' | 'customTitle'>): string[] {
  return [a.customTitle?.trim(), a.title?.trim()].filter((t): t is string => !!t && t !== NAMELESS);
}

export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The program a shell command really runs: skips `cd …`, env assignments and echo noise. */
function commandVerb(cmd: string): string | null {
  for (const seg of cmd.split(/&&|\|\||;|\|/)) {
    const words = seg.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
    const first = words[0]?.replace(/^["']|["']$/g, '');
    if (!first || /^(cd|pushd|set|export|echo|sleep|Set-Location)$/i.test(first)) continue;
    const base = first.split(/[\\/]/).pop() ?? first;
    return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  }
  return null;
}

/** Short friendly line for what a working hero is doing ("⚒ Editing ThemeEditor.tsx"); null when idle. */
export function activityLine(a: Pick<AgentState, 'status' | 'tool' | 'detail'>): string | null {
  if (a.status !== 'running' || !a.tool) return null;
  const tool = a.tool;
  const d = a.detail?.trim() || null;
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return d ? `⚒ Editing ${clip(d, 32)}` : '⚒ Editing';
    case 'Write':
      return d ? `⚒ Writing ${clip(d, 32)}` : '⚒ Writing';
    case 'Read':
      return d ? `📜 Reading ${clip(d, 32)}` : '📜 Reading';
    case 'Grep':
    case 'Glob':
      return d ? `🔍 Searching for “${clip(d, 22)}”` : '🔍 Searching';
    case 'Bash':
    case 'PowerShell': {
      const v = d ? commandVerb(d) : null;
      return v ? `⚙ Running ${clip(v, 20)}` : '⚙ Running a command';
    }
    case 'WebFetch': {
      const host = d ? /^https?:\/\/([^/]+)/i.exec(d)?.[1] : null;
      return host ? `🌐 Reading ${host.replace(/^www\./, '')}` : '🌐 Browsing';
    }
    case 'WebSearch':
      return d ? `🌐 Searching “${clip(d, 22)}”` : '🌐 Searching the web';
    case 'Task':
    case 'Agent':
      return '⚔ Sending a squire';
    case 'TodoWrite':
      return '📋 Updating the plan';
    case 'Skill':
      return d ? `✨ Using ${clip(d, 24)}` : '✨ Using a skill';
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  if (mcp) return `🔌 ${clip(mcp[1] ?? '', 16)} · ${clip((mcp[2] ?? '').replace(/_/g, ' '), 20)}`;
  return `🔧 ${clip(tool, 24)}`;
}

/** Branch worth showing — detached HEAD and blanks are noise. */
export function agentBranch(a: Pick<AgentState, 'gitBranch'>): string | null {
  const b = a.gitBranch?.trim();
  return b && b !== 'HEAD' ? b : null;
}

export function resumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

export function forkCommand(sessionId: string, name: string): string {
  return `claude --resume ${sessionId} --fork-session --name "${name.replace(/"/g, '')}"`;
}

export function newSessionCommand(): string {
  return `claude --name ${NAMELESS}`;
}
