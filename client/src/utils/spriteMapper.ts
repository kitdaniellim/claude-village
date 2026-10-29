// Tool → building mapping + shared visual vocabulary (PROTOCOL.md is the
// source of truth for the mapping table and status colours).

import type { AgentStatus, BuildingId, BuildingInfo } from '../types/agent';

const TOOL_BUILDINGS: Record<string, BuildingId> = {
  // library — reading & searching
  Read: 'library',
  Glob: 'library',
  LS: 'library',
  Grep: 'library',
  NotebookRead: 'library',
  // forge — writing & editing
  Edit: 'forge',
  Write: 'forge',
  MultiEdit: 'forge',
  NotebookEdit: 'forge',
  // arena — shells & execution
  Bash: 'arena',
  PowerShell: 'arena',
  BashOutput: 'arena',
  KillShell: 'arena',
  Execute: 'arena',
  // castle — delegation
  Task: 'castle',
  Agent: 'castle',
  Workflow: 'castle',
  // watchtower — planning
  TodoRead: 'watchtower',
  TodoWrite: 'watchtower',
  EnterPlanMode: 'watchtower',
  ExitPlanMode: 'watchtower',
  // chapel — the web
  WebSearch: 'chapel',
  WebFetch: 'chapel',
};

/**
 * Where a hero should walk, per PROTOCOL.md:
 * - `idle` / `done`  → tavern (regardless of tool)
 * - no tool (e.g. `thinking` before any tool ran) → null = the village square
 * - otherwise the tool's building, defaulting to the alchemist (MCP & friends)
 */
export function toolToBuilding(tool: string | null, status: AgentStatus): BuildingId | null {
  if (status === 'idle' || status === 'done') return 'tavern';
  if (tool === null || tool === '') return null; // village square
  return TOOL_BUILDINGS[tool] ?? 'alchemist';
}

export const BUILDINGS: BuildingInfo[] = [
  { id: 'library', name: 'Library', caption: 'Read / Glob / LS / Grep' },
  { id: 'forge', name: 'Forge', caption: 'Edit / Write / MultiEdit' },
  { id: 'arena', name: 'Arena', caption: 'Bash / Shell / Execute' },
  { id: 'castle', name: 'Castle', caption: 'Task / Agent / Workflow' },
  { id: 'watchtower', name: 'Watchtower', caption: 'Todos / Plan Mode' },
  { id: 'tavern', name: 'Tavern', caption: 'Idle / Done' },
  { id: 'chapel', name: 'Chapel', caption: 'WebSearch / WebFetch' },
  { id: 'alchemist', name: 'Alchemist', caption: 'MCP / everything else' },
];

export const BUILDING_IDS: BuildingId[] = BUILDINGS.map((b) => b.id);

export function buildingInfo(id: BuildingId): BuildingInfo {
  return BUILDINGS.find((b) => b.id === id) ?? { id, name: id, caption: '' };
}

export const STATUS_COLORS: Record<AgentStatus, string> = {
  thinking: '#a78bfa',
  running: '#60a5fa',
  done: '#4ade80',
  idle: '#9ca3af',
  error: '#f87171',
};

// ── Hero tunic colours (shared by Village sprites + PartyBar avatars) ────────

export const HERO_COLORS: string[] = [
  '#d95763', // ember red
  '#4f8fdd', // lake blue
  '#4cae6e', // meadow green
  '#e0a83c', // harvest gold
  '#a06cd5', // wizard violet
  '#e87ea1', // rose pink
  '#3fc1c9', // glacier teal
  '#c97b4a', // clay orange
  '#94a3c0', // pale steel
  '#9ccc3c', // spring lime
];

/** Stable 32-bit FNV-1a hash — used for tunic colours and crowd offsets. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function heroColorIndex(sessionId: string): number {
  return hashString(sessionId) % HERO_COLORS.length;
}

export function heroColor(sessionId: string): string {
  return HERO_COLORS[heroColorIndex(sessionId)] ?? '#d95763';
}
