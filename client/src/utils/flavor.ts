// Flavour text: the "Frolicking…" style status line Claude Code shows in its
// spinner isn't written to the logs, so we roll our own from status + tool.
// Deterministic per (session, tool, status) so the line doesn't flicker.

import type { AgentState, AgentStatus } from '../types/agent';
import { hashString, toolToBuilding } from './spriteMapper';
import { spinnerVerb } from './spinnerVerbs';

const THINKING = ['Pondering', 'Musing', 'Cogitating', 'Scheming', 'Brewing a plan', 'Ruminating', 'Divining'];
const DONE = ['Frolicking', 'Resting at the tavern', 'Sipping mead', 'Awaiting orders', 'Polishing armour', 'Whistling'];
const IDLE = ['Dozing', 'Daydreaming', 'Napping by the hearth', 'Counting clouds'];
const ERROR = ['Nursing a wound', 'Cursing the gremlins', 'Regrouping', 'Dusting off'];
const DELEGATING = ['Awaiting the squire', 'Pacing the hall', 'Watching the road for scouts', 'Tapping a foot'];
const WAR = ['To arms!', 'For the realm!', 'Hold the line!', 'Charge!', 'Steel and sinew!', 'No quarter!'];

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
  else if (status === 'delegating') list = DELEGATING;
  // Working: Claude Code's own spinner verbs ("Sketching…"), rotating every 8 s like the CLI.
  else return `${spinnerVerb(hashString(a.sessionId))}…`;
  return `${pick(list, seed)}…`;
}

/** The building-flavoured line for a tool ("Hammering code…") — kept for tooltips. */
export function toolFlavorLine(a: Pick<AgentState, 'sessionId' | 'status' | 'tool' | 'eventCount'>): string {
  const seed = (hashString(a.sessionId) + Math.floor(a.eventCount / 3)) >>> 0;
  const b = toolToBuilding(a.tool, a.status);
  return `${pick((b && BY_BUILDING[b]) ?? THINKING, seed)}…`;
}

/** Battle cry for a villager drafted into WAR mode (stable per session). */
export function warLine(a: Pick<AgentState, 'sessionId'>): string {
  return pick(WAR, hashString(a.sessionId) >>> 2);
}

/** The unresolved error, one line, cut to `max` chars (e.g. "Edit: String to replace not found…"). */
export function errorLine(err: NonNullable<AgentState['lastError']>, max = 90): string {
  const detail = (err.detail ?? '').replace(/\s+/g, ' ').trim();
  const text = detail ? detail : `${err.tool ?? 'Something'} failed`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Greedy word wrap into at most `maxLines` lines of about `width` chars. */
export function wrapText(text: string, width: number, maxLines: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  else if (lines.length === maxLines && cur) {
    const last = lines[maxLines - 1] ?? '';
    lines[maxLines - 1] = last.length > width - 1 ? `${last.slice(0, width - 1)}…` : `${last}…`;
  }
  return lines.join('\n');
}
