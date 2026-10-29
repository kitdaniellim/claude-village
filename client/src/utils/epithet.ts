// Hero epithets: a stable title per session ("Ser X the Bold", "Conqueror of
// X") hashed from the session id. The name itself is never shortened — the
// epithet only decorates it. Squires are always "Squire X" (no role-of form).

import type { AgentState } from '../types/agent';
import { SQUIRE_NAME_RE, agentName } from './agentLabel';
import { hashString } from './spriteMapper';

type Words = readonly [string, ...string[]];

const PREFIXES = [
  'Ser',
  'Dame',
  'Lord',
  'Lady',
  'Sir',
  'Captain',
  'Archmage',
  'Elder',
  'Paladin',
  'Marshal',
  'Magister',
  'Baron',
] as const satisfies Words;

const ROLES = [
  'Conqueror of',
  'Defender of',
  'Warden of',
  'Keeper of',
  'Herald of',
  'Bane of',
  'Champion of',
  'Scourge of',
  'Sentinel of',
  'Steward of',
  'Chronicler of',
  'Wanderer of',
] as const satisfies Words;

const SUFFIXES = [
  'the Bold',
  'the Tireless',
  'the Unyielding',
  'of the Forge',
  'Slayer of Bugs',
  'the Sleepless',
  'Breaker of Builds',
  'the Patient',
  'of Many Tabs',
  'the Relentless',
  'Tamer of Lints',
  'the Meticulous',
  'of the Long Night',
  'the Unmerged',
  'the Swift',
  'Reader of Logs',
  'the Wary',
  'Bringer of Green Checks',
  'of the Endless Backlog',
  'the Thrice-Rebased',
] as const satisfies Words;

export interface Epithet {
  /** Goes before the name: a title ("Dame") or a role ("Warden of"). */
  prefix: string | null;
  /** Goes after the name ("the Sleepless"). */
  suffix: string | null;
}

function pick(list: Words, n: number): string {
  return list[n % list.length] ?? list[0];
}

/** Deterministic per session; its own hash family so titles don't track tunic colours or looks. */
export function heroEpithet(sessionId: string): Epithet {
  const h = hashString(`${sessionId}:epithet`);
  const form = h & 7;
  const prefix = pick(PREFIXES, h >>> 3);
  const role = pick(ROLES, h >>> 8);
  const suffix = pick(SUFFIXES, h >>> 13);
  if (form < 2) return { prefix, suffix: null }; // Ser X
  if (form < 4) return { prefix: null, suffix }; // X the Bold
  if (form < 6) return { prefix, suffix }; // Dame X the Tireless
  return { prefix: role, suffix: null }; // Conqueror of X
}

/** "Squire Nameless the Swift"; a name that already reads "Squire of …" gets no prefix. */
export function squireEpithet(sessionId: string, name: string): Epithet {
  const h = hashString(`${sessionId}:epithet`);
  return {
    prefix: SQUIRE_NAME_RE.test(name) ? null : 'Squire',
    suffix: (h & 1) === 0 ? pick(SUFFIXES, h >>> 13) : null,
  };
}

export function epithetOf(sessionId: string, name: string, squire: boolean): Epithet {
  return squire ? squireEpithet(sessionId, name) : heroEpithet(sessionId);
}

/** "Ser MY VILLAGE the Tireless" for any session + display name (journal rows, toasts). */
export function epithetTitle(sessionId: string, name: string, squire = SQUIRE_NAME_RE.test(name)): string {
  const e = epithetOf(sessionId, name, squire);
  return [e.prefix, name, e.suffix].filter(Boolean).join(' ');
}

export function heroTitle(a: Pick<AgentState, 'sessionId' | 'title' | 'customTitle' | 'isSquire'>): string {
  return epithetTitle(a.sessionId, agentName(a), a.isSquire);
}
