// Hero portraits: cells of CobraLad's "32x32 fantasy portrait set" sheet
// (CC-BY 3.0 — client/public/assets/portraits/fantasy-32/LICENSE.txt), picked
// per session to match the LPC look the hero wears in the village.

import type { CSSProperties } from 'react';
import { LOOKS, lookFor } from '../world/lpcHero';
import type { LookGear } from '../world/lpcHero';
import { hashString } from './spriteMapper';

/** Relative so it resolves under both the dev server and the file:// desktop build. */
export const PORTRAIT_SHEET_URL = 'assets/portraits/fantasy-32/portraits.png';
export const PORTRAIT_PX = 32;
export const PORTRAIT_SHEET_W = 175;
export const PORTRAIT_SHEET_H = 146;

export interface PortraitCell {
  /** Top-left pixel of the face on the sheet. */
  x: number;
  y: number;
  name: string;
}

/** The 13 faces, in the author's 1p…13p order (14p is a "?" placeholder — never shown). */
export const PORTRAITS: readonly PortraitCell[] = [
  { x: 5, y: 7, name: 'bearded warrior' },
  { x: 38, y: 7, name: 'bald man' },
  { x: 71, y: 7, name: 'headband rogue' },
  { x: 104, y: 7, name: 'circlet woman' },
  { x: 137, y: 7, name: 'orc' },
  { x: 5, y: 40, name: 'old wizard' },
  { x: 38, y: 40, name: 'skull' },
  { x: 71, y: 40, name: 'stone brute' },
  { x: 104, y: 40, name: 'red-haired woman' },
  { x: 137, y: 40, name: 'gilded mask' },
  { x: 5, y: 73, name: 'grey-haired woman' },
  { x: 38, y: 72, name: 'hooded helm' },
  { x: 71, y: 73, name: 'bearded dwarf' },
];

// Faces by index into PORTRAITS, named for the tables below.
const WARRIOR = 0;
const BALD = 1;
const ROGUE = 2;
const CIRCLET = 3;
const ORC = 4;
const WIZARD = 5;
const SKULL = 6;
const BRUTE = 7;
const REDHEAD = 8;
const MASK = 9;
const GREYHAIR = 10;
const HOOD = 11;
const DWARF = 12;

type Pool = readonly [number, ...number[]];

/** Human faces — the only ones a hero or squire of ours is ever dealt. */
export const GOOD_PORTRAITS: Pool = [WARRIOR, BALD, ROGUE, CIRCLET, WIZARD, REDHEAD, GREYHAIR, HOOD, DWARF];

/** Monster faces (green orc, skull, grey-skinned brute, red-eyed tusked mask) — for monsters only. */
export const EVIL_PORTRAITS: Pool = [ORC, SKULL, BRUTE, MASK];

/**
 * Faces by the gear class a look wears (LOOKS[i].gear), so the portrait always matches the sprite:
 * armored = the chain-coif / nasal-helm face (the only armoured portrait); hooded = the cowled old man;
 * plain = bare-headed men (short-haired, bearded, braided-beard). GREYHAIR is unused by heroes.
 */
const GEAR_PORTRAITS: Record<LookGear, Pool> = {
  armored: [HOOD],
  hooded: [WIZARD],
  plain: [BALD, WARRIOR, DWARF],
};

/** The young, unarmoured faces — reserved for squires (villager look: no armour, bare head). */
const SQUIRE_PORTRAITS: Pool = [ROGUE, CIRCLET, REDHEAD];
const LOOK_PORTRAITS: readonly Pool[] = LOOKS.map((l) => GEAR_PORTRAITS[l.gear]);
const ARMORED_FACES: readonly number[] = [HOOD];

// Dev guard: no hero/squire pool may ever reach a monster face, and armour must match on both sides.
if (import.meta.env.DEV) {
  for (const pool of [...LOOK_PORTRAITS, SQUIRE_PORTRAITS]) {
    for (const i of pool) if (!GOOD_PORTRAITS.includes(i)) throw new Error(`portraits: hero pool uses evil face ${i}`);
  }
  LOOKS.forEach((l, li) => {
    for (const i of LOOK_PORTRAITS[li] ?? []) {
      if ((l.gear === 'armored') !== ARMORED_FACES.includes(i)) throw new Error(`portraits: look ${l.name} (${l.gear}) dealt face ${i}`);
    }
  });
  for (const i of SQUIRE_PORTRAITS) if (ARMORED_FACES.includes(i)) throw new Error(`portraits: squire dealt armoured face ${i}`);
}

/** Index into PORTRAITS for a session: the look's (or squire) list, then an uncorrelated hash slice within it. */
export function portraitIndex(sessionId: string, squire = false): number {
  const h = hashString(sessionId);
  const list = squire ? SQUIRE_PORTRAITS : (LOOK_PORTRAITS[lookFor(h)] ?? LOOK_PORTRAITS[0]);
  if (!list) return 0;
  return list[(h >>> 13) % list.length] ?? list[0];
}

export function portraitFor(sessionId: string, squire = false): PortraitCell {
  return PORTRAITS[portraitIndex(sessionId, squire)] ?? PORTRAITS[0] ?? { x: 5, y: 7, name: 'bearded warrior' };
}

/** Monster face for a kind ("orc", "skeleton", "ghoul", "warlord"…): named match first, else a stable hash into EVIL_PORTRAITS. */
export function monsterPortrait(kind: string): PortraitCell {
  const k = kind.toLowerCase();
  let i: number;
  if (/orc|goblin|troll|ogre/.test(k)) i = ORC;
  else if (/skull|skelet|undead|lich|wraith|ghost/.test(k)) i = SKULL;
  else if (/ghoul|brute|golem|zombie|giant/.test(k)) i = BRUTE;
  else if (/mask|warlord|cultist|knight|demon/.test(k)) i = MASK;
  else i = EVIL_PORTRAITS[hashString(k) % EVIL_PORTRAITS.length] ?? EVIL_PORTRAITS[0];
  return PORTRAITS[i] ?? PORTRAITS[ORC] ?? { x: 137, y: 7, name: 'orc' };
}

/** Sprite box for one cell; `scale` is an integer so nearest-neighbour stays exact. */
export function portraitStyle(cell: PortraitCell, scale: 1 | 2 = 1): CSSProperties {
  const px = PORTRAIT_PX * scale;
  return {
    width: px,
    height: px,
    backgroundImage: `url(${PORTRAIT_SHEET_URL})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${PORTRAIT_SHEET_W * scale}px ${PORTRAIT_SHEET_H * scale}px`,
    backgroundPosition: `${-cell.x * scale}px ${-cell.y * scale}px`,
    imageRendering: 'pixelated',
  };
}

// ── Sheet load state (shared; the fallback square shows until 'ok') ──────────

export type SheetState = 'loading' | 'ok' | 'err';

let sheetState: SheetState = 'loading';
let started = false;
const listeners = new Set<() => void>();

function startLoading(): void {
  if (started || typeof Image === 'undefined') return;
  started = true;
  const img = new Image();
  img.decoding = 'async';
  const settle = (s: SheetState): void => {
    sheetState = s;
    for (const l of listeners) l();
  };
  img.onload = () => settle('ok');
  img.onerror = () => settle('err');
  img.src = PORTRAIT_SHEET_URL;
}

/** useSyncExternalStore subscribe — also kicks off the download on first use. */
export function subscribePortraitSheet(cb: () => void): () => void {
  startLoading();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function portraitSheetState(): SheetState {
  return sheetState;
}
