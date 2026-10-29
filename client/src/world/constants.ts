// World dimensions, place footprints and the default/slot layout.
// Layout positions are tile coordinates of a place's top-left footprint corner.

import type { PlaceKind } from './registry';

export const TILE = 16;
export const TILES_X = 96;
export const TILES_Y = 60;
export const WORLD_W = TILES_X * TILE; // 1536
export const WORLD_H = TILES_Y * TILE; // 960
export const WORLD_SEED = 0x5eed1e7;
export const HERO_SPEED = 58; // px / second along roads

export interface TilePos {
  tx: number;
  ty: number;
}

/** Footprint (in tiles) of each place kind; the big cities get their own sizes. */
export function footprintFor(kind: PlaceKind, placeId: string): { tw: number; th: number } {
  if (kind === 'tavern') return { tw: 18, th: 12 };
  if (kind === 'city') return placeId === 'habits' ? { tw: 17, th: 12 } : { tw: 21, th: 14 };
  if (kind === 'dungeon') return { tw: 18, th: 12 };
  if (kind === 'lair') return { tw: 20, th: 14 };
  return { tw: 6, th: 6 };
}

/** Tavern default (centred on the map); also the fallback when no layout names it. */
export const TAVERN_TILE: TilePos = { tx: 39, ty: 24 };

/** Hand-tuned default positions for the static places. */
export const DEFAULT_PLACE_TILES: Record<string, TilePos> = {
  tavern: TAVERN_TILE,
  sif: { tx: 5, ty: 4 },
  habits: { tx: 74, ty: 4 },
  momma: { tx: 5, ty: 43 },
  simone: { tx: 71, ty: 41 },
  portfolio: { tx: 87, ty: 25 },
  'rts-agents': { tx: 45, ty: 49 },
};

/** Free edge slots handed out (in order) to wild places that have no saved position. */
export const WILD_SLOTS: TilePos[] = [
  { tx: 3, ty: 24 },
  { tx: 45, ty: 3 },
  { tx: 3, ty: 33 },
  { tx: 87, ty: 34 },
  { tx: 30, ty: 3 },
  { tx: 60, ty: 3 },
  { tx: 30, ty: 50 },
  { tx: 60, ty: 50 },
  { tx: 16, ty: 3 },
  { tx: 3, ty: 16 },
  { tx: 87, ty: 17 },
  { tx: 3, ty: 50 },
];
