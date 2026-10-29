// Tavern plaza helpers: the deterministic rest grid on the lower half of the
// cobbles (every slot ≥ 28 px from its neighbours so name labels don't pile
// up) and the ellipse clamp used while a hero is dragged around.

import type { PlaceGeom } from './places';
import { PLAZA_SQUASH } from './places';
import type { Pt } from './pixel';

/** Minimum distance between two resting heroes. */
export const REST_MIN_GAP = 28;

/** Rows below the plaza centre; x offsets shrink with the ellipse. */
const ROWS: Array<{ dy: number; xs: number[] }> = [
  { dy: 0, xs: [-80, -40, 0, 40, 80] },
  { dy: 34, xs: [-54, -18, 18, 54] },
  { dy: 68, xs: [-40, 0, 40] },
];

/** Rest slots in world px (12 of them). */
export function plazaRestSlots(g: PlaceGeom): Pt[] {
  const c = g.plaza?.c ?? g.square;
  return ROWS.flatMap((r) => r.xs.map((dx) => ({ x: c.x + dx, y: c.y + r.dy })));
}

/** Pulls a point inside the plaza (inset so the sprite stays on the cobbles) and out from under the inn. */
export function clampToPlaza(g: PlaceGeom, p: Pt): Pt {
  const plaza = g.plaza;
  if (!plaza) return p;
  const rx = plaza.r - 12;
  const ry = plaza.r * PLAZA_SQUASH - 8;
  let dx = p.x - plaza.c.x;
  let dy = p.y - plaza.c.y;
  const k = Math.hypot(dx / rx, dy / ry);
  if (k > 1) {
    dx /= k;
    dy /= k;
  }
  const x = plaza.c.x + dx;
  let y = plaza.c.y + dy;
  const inn = g.buildings[0]?.rect;
  if (inn && x > inn.x - 6 && x < inn.x + inn.w + 6 && y < inn.y + inn.h + 4) y = inn.y + inn.h + 4;
  return { x, y };
}
