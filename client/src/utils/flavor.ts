// Flavour text: the "Frolicking…" style status line Claude Code shows in its
// spinner isn't written to the logs, so we roll our own from status + tool.
// Deterministic per (session, tool, status) so the line doesn't flicker.

import type { AgentState, AgentStatus } from '../types/agent';
import { hashString, toolToBuilding } from './spriteMapper';

const THINKING = ['Pondering', 'Musing', 'Cogitating', 'Scheming', 'Brewing a plan', 'Ruminating', 'Divining'];
const DONE = ['Frolicking', 'Resting at the tavern', 'Sipping mead', 'Awaiting orders', 'Polishing armour', 'Whistling'];
const IDLE = ['Dozing', 'Daydreaming', 'Napping by the hearth', 'Counting clouds'];
const ERROR = ['Nursing a wound', 'Cursing the gremlins', 'Regrouping', 'Dusting off'];

const BY_BUILDING: Record<string, string[]> = {
  library: ['Studying tomes', 'Leafing through scrolls', 'Consulting the archives', 'Deciphering runes'],
  forge: ['Hammering code', 'Forging changes', 'Tempering the blade', 'Smithing'],
  arena: ['Sparring', 'Running drills', 'Testing mettle', 'Brawling with the shell'],
  castle: ['Rallying allies', 'Commanding the host', 'Dispatching scouts'],
  watchtower: ['Surveying the land', 'Charting the quest', 'Plotting the route'],
  chapel: ['Seeking wisdom', 'Consulting the oracle', 'Praying for answers'],
  alchemist: ['Brewing potions', 'Transmuting', 'Dabbling in the arcane', 'Mixing reagents'],
  tavern: DONE,
};

function pick(list: string[], seed: number): string {
  return list[seed % list.length] ?? list[0] ?? '…';
}

/** One short present-tense line for the party card / speech bubble, e.g. "Hammering code…". */
export function flavorLine(a: Pick<AgentState, 'sessionId' | 'status' | 'tool' | 'eventCount'>): string {
  const seed = (hashString(a.sessionId) + Math.floor(a.eventCount / 3)) >>> 0;
  const status: AgentStatus = a.status;
  let list: string[];
  if (status === 'error') list = ERROR;
  else if (status === 'idle') list = IDLE;
  else if (status === 'done') list = DONE;
  else if (status === 'running') {
    const b = toolToBuilding(a.tool, status);
    list = (b && BY_BUILDING[b]) ?? BY_BUILDING['alchemist'] ?? THINKING;
  } else list = THINKING;
  return `${pick(list, seed)}…`;
}
