// Shared session labels: display name, "City · Repo" place line, cwd fallback
// and the by-hand resume command (shown when no desktop bridge exists).

import type { AgentState } from '../types/agent';
import { TAVERN_PLACE, resolveAgentPlace } from '../world/registry';

/** Where terminals start when a session never reported a cwd. */
export const FALLBACK_CWD = 'G:\\daniels things\\coding';

type Named = Pick<AgentState, 'title' | 'customTitle'>;
type Placed = Pick<AgentState, 'cwd' | 'rootCwd' | 'title' | 'customTitle'>;

/** The user's /rename name wins, then the AI title, then a placeholder. */
export function agentName(a: Named): string {
  return a.customTitle?.trim() || a.title?.trim() || 'Untitled quest';
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

/** Branch worth showing — detached HEAD and blanks are noise. */
export function agentBranch(a: Pick<AgentState, 'gitBranch'>): string | null {
  const b = a.gitBranch?.trim();
  return b && b !== 'HEAD' ? b : null;
}

export function resumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}
