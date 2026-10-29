// Wavy dirt roads: noise-displaced waypoints smoothed with Catmull-Rom, from
// the tavern plaza rim to every place, plus a few side paths between
// neighbours. Deterministic from the layout (seeded by place ids).

import { catmullRom } from './geometry';
import type { PlaceGeom } from './places';
import { drawPixelDisc, hash32, mulberry32 } from './pixel';
import type { Pt } from './pixel';

export interface Road {
  id: string;
  /** Place this road leads to (from the plaza). Side paths use `a->b`. */
  placeId: string;
  /** From the plaza rim to the place's gate. */
  pts: Pt[];
  width: number;
}

export interface RoadNet {
  /** Main roads keyed by place id. */
  main: Map<string, Road>;
  side: Road[];
}

function wavy(from: Pt, to: Pt, rng: () => number, amp: number): Pt[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const n = len > 420 ? 4 : len > 220 ? 3 : 2;
  const pts: Pt[] = [from];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const off = (rng() - 0.5) * 2 * amp * Math.sin(t * Math.PI);
    pts.push({ x: from.x + dx * t + nx * off, y: from.y + dy * t + ny * off });
  }
  pts.push(to);
  return pts;
}

export function buildRoads(tavern: PlaceGeom, places: PlaceGeom[], seed: number): RoadNet {
  const main = new Map<string, Road>();
  const side: Road[] = [];
  const plaza = tavern.plaza ?? { c: { x: tavern.rect.x + tavern.rect.w / 2, y: tavern.rect.y + tavern.rect.h / 2 }, r: 40 };
  for (const p of places) {
    if (p.kind === 'tavern') continue;
    const rng = mulberry32(seed ^ hash32(p.id));
    const dx = p.approach.x - plaza.c.x;
    const dy = p.approach.y - plaza.c.y;
    const len = Math.hypot(dx, dy) || 1;
    const start: Pt = { x: plaza.c.x + (dx / len) * (plaza.r + 2), y: plaza.c.y + (dy / len) * (plaza.r + 2) * 0.82 };
    const amp = Math.min(56, len * 0.14);
    const way = [...wavy(start, p.approach, rng, amp), p.gate];
    main.set(p.id, { id: p.id, placeId: p.id, pts: catmullRom(way, 5), width: p.kind === 'wild' ? 22 : 30 });
  }
  // side paths: each place links to its nearest neighbour (once)
  const linked = new Set<string>();
  const others = places.filter((p) => p.kind !== 'tavern');
  for (const a of others) {
    let best: PlaceGeom | null = null;
    let bestD = Infinity;
    for (const b of others) {
      if (b === a) continue;
      const d = Math.hypot(a.approach.x - b.approach.x, a.approach.y - b.approach.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best || bestD > 560) continue;
    const key = [a.id, best.id].sort().join('->');
    if (linked.has(key)) continue;
    linked.add(key);
    const rng = mulberry32(seed ^ hash32(key));
    side.push({ id: key, placeId: key, pts: catmullRom(wavy(a.approach, best.approach, rng, Math.min(40, bestD * 0.12)), 5), width: 14 });
  }
  return { main, side };
}

const PATH_BASE = '#d9b380';
const PATH_DARK = '#c9a06b';
const PATH_LIGHT = '#e4c794';
const PATH_EDGE = '#bb9260';
const PATH_WORN = '#cfa874';

/** Paint a road into the terrain: worn edge, base, ruts, speckles, pebbles, grass bleed. */
export function paintRoad(ctx: CanvasRenderingContext2D, road: Road, seed: number): void {
  const rng = mulberry32(seed ^ hash32(road.id) ^ 0x9e3779b9);
  const r = road.width / 2;
  const pts = road.pts;
  const wobble = (i: number): number => Math.sin(i * 0.9) * 2 + Math.sin(i * 0.37) * 2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Pt;
    drawPixelDisc(ctx, p.x, p.y, Math.round(r + 3 + wobble(i)), PATH_EDGE);
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Pt;
    drawPixelDisc(ctx, p.x, p.y, Math.round(r + wobble(i) * 0.7), PATH_BASE);
  }
  if (r >= 10) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as Pt;
      drawPixelDisc(ctx, p.x, p.y, Math.round(r * 0.38), PATH_WORN);
    }
  }
  // speckles + pebbles + grass bleeding in from the edges
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Pt;
    for (let k = 0; k < 3; k++) {
      const a = rng() * Math.PI * 2;
      const rr = rng() * (r - 2);
      ctx.fillStyle = rng() < 0.55 ? PATH_DARK : PATH_LIGHT;
      ctx.fillRect(Math.round(p.x + Math.cos(a) * rr), Math.round(p.y + Math.sin(a) * rr), 2, 1 + Math.floor(rng() * 2));
    }
    if (rng() < 0.08) {
      const a = rng() * Math.PI * 2;
      const rr = rng() * (r - 4);
      const px = Math.round(p.x + Math.cos(a) * rr);
      const py = Math.round(p.y + Math.sin(a) * rr);
      ctx.fillStyle = '#a39a8a';
      ctx.fillRect(px, py, 4, 3);
      ctx.fillStyle = '#bfb6a6';
      ctx.fillRect(px + 1, py, 2, 1);
      ctx.fillStyle = '#827a6c';
      ctx.fillRect(px, py + 2, 4, 1);
    }
    if (rng() < 0.35) {
      const a = rng() * Math.PI * 2;
      const rr = r + 1 + rng() * 3;
      ctx.fillStyle = rng() < 0.5 ? '#6da33f' : '#8bc34a';
      ctx.fillRect(Math.round(p.x + Math.cos(a) * rr), Math.round(p.y + Math.sin(a) * rr), 2, 2);
    }
  }
}

/** True when (x, y) lies within `margin` of any road centreline. */
export function nearRoad(net: RoadNet, x: number, y: number, margin: number): boolean {
  const test = (road: Road): boolean => {
    const lim = (road.width / 2 + margin) ** 2;
    for (let i = 0; i < road.pts.length; i += 2) {
      const p = road.pts[i] as Pt;
      if ((p.x - x) ** 2 + (p.y - y) ** 2 < lim) return true;
    }
    return false;
  };
  for (const r of net.main.values()) if (test(r)) return true;
  for (const r of net.side) if (test(r)) return true;
  return false;
}
