// The river: one meandering, seeded watercourse routed around every place
// footprint and the plaza (a cost-grid search from the edge nearest the farm
// town, then smoothed), painted as a pixel-art layer with banks, a static
// shine and wooden bridges wherever a road crosses it. Water is not walkable
// except on a bridge deck (see World.water in terrain.ts).

import { TILE, TILES_X, TILES_Y, WORLD_H, WORLD_W } from './constants';
import { catmullRom } from './geometry';
import { hash32, mulberry32 } from './pixel';
import type { Pt, Rect } from './pixel';
import type { PlaceGeom } from './places';
import type { Road, RoadNet } from './roads';
import { vnoise2 } from './biomes';

export interface WaterBridge {
  /** Road this deck carries. */
  road: string;
  /** Centreline of the deck, bank to bank plus a short run onto land each side. */
  pts: Pt[];
  /** Full deck width in px. */
  width: number;
}

/**
 * Static water geometry (world.water; null-free: an empty river has empty arrays).
 * `depth` and `deck` are world-pixel grids (index y * WORLD_W + x); `mask` is the coarse walk-block grid.
 */
export interface WaterGeom {
  /** px per `mask` cell. */
  cell: number;
  cols: number;
  rows: number;
  /** 1 = open water a hero cannot walk on (bridge decks carved out). Index cy * cols + cx. */
  mask: Uint8Array;
  /** Per world pixel: > 0 inside the river (px to the nearest bank), <= 0 on land (clamped at -9). Includes bridge pixels. */
  depth: Float32Array;
  /** Per world pixel: 1 on a bridge deck. */
  deck: Uint8Array;
  /** River centreline, upstream to downstream, ~6 px apart, and the half-width at each point. */
  path: Pt[];
  halfW: number[];
  /** Bridges where roads cross the river. */
  bridges: WaterBridge[];
  /** Spots where the static shine was drawn (centre of a 3 px glint): the ambient layer can twinkle these. */
  shine: Pt[];
  /** Bounding rect of the river's pixels. */
  bounds: Rect;
}

const CELL = 4;
const COLS = Math.ceil(WORLD_W / CELL);
const ROWS = Math.ceil(WORLD_H / CELL);
const LAND = -9;
/** Clearance kept between the river's centreline and any place / the plaza when routing (px). */
const PLACE_MARGIN = 58;

// ── routing ──────────────────────────────────────────────────────────────────

function distRect(x: number, y: number, r: Rect): number {
  return Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h)));
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    let i = this.k.length;
    this.k.push(key);
    this.v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.k[p] ?? 0) <= key) break;
      this.k[i] = this.k[p] ?? 0;
      this.v[i] = this.v[p] ?? 0;
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0] ?? 0;
    const lk = this.k.pop() ?? 0;
    const lv = this.v.pop() ?? 0;
    const n = this.k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (this.k[c + 1] ?? 0) < (this.k[c] ?? 0)) c++;
        if ((this.k[c] ?? 0) >= lk) break;
        this.k[i] = this.k[c] ?? 0;
        this.v[i] = this.v[c] ?? 0;
        i = c;
      }
      this.k[i] = lk;
      this.v[i] = lv;
    }
    return top;
  }
}

/** Tile-grid route from the edge nearest the farm town to the opposite edge, or null when nothing clears the places. */
function routeRiver(places: PlaceGeom[], seed: number): Pt[] | null {
  const plaza = places.find((p) => p.plaza)?.plaza ?? null;
  const town = places.find((p) => p.id === 'habits') ?? places.find((p) => p.kind === 'city') ?? null;
  const nx = TILES_X;
  const ny = TILES_Y;
  const blocked = new Uint8Array(nx * ny);
  const cost = new Float32Array(nx * ny);
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const x = tx * TILE + TILE / 2;
      const y = ty * TILE + TILE / 2;
      let c = 1 + vnoise2(x / 90, y / 90, seed) * 3.2 + vnoise2(x / 31, y / 31, seed ^ 5) * 1.2;
      for (const g of places) {
        if (g.kind === 'tavern') continue;
        const d = distRect(x, y, g.rect);
        if (d < PLACE_MARGIN) blocked[ty * nx + tx] = 1;
        else if (d < PLACE_MARGIN + 40) c += 1.4;
      }
      if (plaza && Math.hypot(x - plaza.c.x, (y - plaza.c.y) / 0.82) < plaza.r + PLACE_MARGIN) blocked[ty * nx + tx] = 1;
      for (const g of places) if (g.kind === 'tavern' && distRect(x, y, g.rect) < PLACE_MARGIN) blocked[ty * nx + tx] = 1;
      if (town) {
        // hug the farm town: a gentle pull towards the 60-130 px ring around it
        const d = distRect(x, y, town.rect);
        if (d > 50 && d < 140) c *= 0.55;
      }
      if (tx < 2 || ty < 2 || tx >= nx - 2 || ty >= ny - 2) c += 2;
      cost[ty * nx + tx] = c;
    }
  }
  const rng = mulberry32(seed ^ 0x71be5);
  const fromTop = town ? town.rect.y + town.rect.h / 2 < WORLD_H / 2 : rng() < 0.5;
  const startX = town
    ? town.rect.x - 70 > 80
      ? town.rect.x - 70
      : town.rect.x + town.rect.w + 70
    : WORLD_W * (0.3 + rng() * 0.4);
  const sy = fromTop ? 1 : ny - 2;
  const sx = Math.max(2, Math.min(nx - 3, Math.round(startX / TILE)));
  const gx0 = Math.round((WORLD_W * (0.5 + rng() * 0.22)) / TILE);
  const gy = fromTop ? ny - 2 : 1;
  const free = (tx: number, ty: number): boolean => tx >= 0 && ty >= 0 && tx < nx && ty < ny && !blocked[ty * nx + tx];
  // nearest unblocked start / goal cells on their edge rows
  const pickOnRow = (x0: number, y: number): number | null => {
    for (let d = 0; d < nx; d++) {
      for (const x of [x0 - d, x0 + d]) if (x >= 2 && x < nx - 2 && free(x, y)) return x;
    }
    return null;
  };
  const sCol = pickOnRow(sx, sy);
  const gCol = pickOnRow(gx0, gy);
  if (sCol === null || gCol === null) return null;
  const goal = gy * nx + gCol;
  const start = sy * nx + sCol;
  const dist = new Float32Array(nx * ny).fill(Infinity);
  const prev = new Int32Array(nx * ny).fill(-1);
  const heap = new Heap();
  dist[start] = 0;
  heap.push(0, start);
  const gcx = gCol;
  const gcy = gy;
  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    const cx = cur % nx;
    const cy = (cur - cx) / nx;
    const dc = dist[cur] ?? Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!free(x, y)) continue;
        // a diagonal may not squeeze between two blocked cells
        if (dx && dy && (!free(cx + dx, cy) || !free(cx, cy + dy))) continue;
        const i = y * nx + x;
        const nd = dc + (cost[i] ?? 1) * (dx && dy ? 1.414 : 1);
        if (nd < (dist[i] ?? Infinity)) {
          dist[i] = nd;
          prev[i] = cur;
          // light A* pull towards the goal keeps the river from wandering back upstream
          heap.push(nd + Math.hypot(x - gcx, y - gcy) * 0.9, i);
        }
      }
    }
  }
  if (!Number.isFinite(dist[goal] ?? Infinity)) return null;
  const cells: Pt[] = [];
  for (let i = goal; i >= 0; i = prev[i] ?? -1) {
    cells.push({ x: (i % nx) * TILE + TILE / 2, y: Math.floor(i / nx) * TILE + TILE / 2 });
    if (i === start) break;
  }
  cells.reverse();
  // run off the map edges at both ends
  const first = cells[0] as Pt;
  const last = cells[cells.length - 1] as Pt;
  return [{ x: first.x, y: fromTop ? -40 : WORLD_H + 40 }, ...cells, { x: last.x, y: fromTop ? WORLD_H + 40 : -40 }];
}

/** Smoothed, gently meandering centreline (~6 px steps) with the half-width at each point. */
function shapeRiver(route: Pt[], seed: number): { path: Pt[]; halfW: number[] } {
  let pts = catmullRom(route, 6);
  // relax the grid zig-zag: two moving-average passes (ends pinned)
  for (let pass = 0; pass < 3; pass++) {
    pts = pts.map((p, i) => {
      if (i < 3 || i > pts.length - 4) return p;
      let sx = 0;
      let sy = 0;
      for (let k = -3; k <= 3; k++) {
        const q = pts[i + k] as Pt;
        sx += q.x;
        sy += q.y;
      }
      return { x: sx / 7, y: sy / 7 };
    });
  }
  // lateral meander on top
  const path: Pt[] = [];
  const halfW: number[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Pt;
    const a = pts[Math.max(0, i - 1)] as Pt;
    const b = pts[Math.min(pts.length - 1, i + 1)] as Pt;
    if (i > 0) s += Math.hypot(p.x - (pts[i - 1] as Pt).x, p.y - (pts[i - 1] as Pt).y);
    const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nxv = -(b.y - a.y) / tl;
    const nyv = (b.x - a.x) / tl;
    const off = Math.sin(s / 38 + (seed & 255)) * 7 + Math.sin(s / 17) * 2.5;
    path.push({ x: p.x + nxv * off, y: p.y + nyv * off });
    halfW.push(11.5 + vnoise2(s / 60, 3, seed ^ 0x33) * 4 + Math.sin(s / 29) * 1.2);
  }
  return { path, halfW };
}

// ── geometry ─────────────────────────────────────────────────────────────────

/** Calls `cb(x, y, s, u)` for every deck pixel of a bridge: s = arc length along it, u = lateral offset from the centreline. */
function forEachDeckPx(b: WaterBridge, cb: (x: number, y: number, s: number, u: number) => void): void {
  const hw = b.width / 2;
  let s = 0;
  for (let i = 0; i < b.pts.length - 1; i++) {
    const a = b.pts[i] as Pt;
    const c = b.pts[i + 1] as Pt;
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    if (len < 0.01) continue;
    const tx = (c.x - a.x) / len;
    const ty = (c.y - a.y) / len;
    for (let l = 0; l < len; l += 0.5) {
      const px = a.x + tx * l;
      const py = a.y + ty * l;
      for (let u = -hw; u <= hw; u += 0.5) cb(Math.round(px - ty * u), Math.round(py + tx * u), s + l, u);
    }
    s += len;
  }
}

function roadBridges(road: Road, depth: Float32Array): WaterBridge[] {
  const wet = (p: Pt): boolean => {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    return x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H && (depth[y * WORLD_W + x] ?? LAND) > -4;
  };
  const out: WaterBridge[] = [];
  const pts = road.pts;
  let i = 0;
  while (i < pts.length) {
    if (!wet(pts[i] as Pt)) {
      i++;
      continue;
    }
    let j = i;
    // a short dry gap (a sandbar) does not split the bridge
    for (let k = i; k < pts.length && k - j < 5; k++) if (wet(pts[k] as Pt)) j = k;
    const from = Math.max(0, i - 3);
    const to = Math.min(pts.length - 1, j + 3);
    out.push({ road: road.id, pts: pts.slice(from, to + 1).map((p) => ({ ...p })), width: Math.min(road.width, 22) - 4 });
    i = j + 1;
  }
  return out;
}

export function buildWater(places: PlaceGeom[], roads: RoadNet, seed: number): WaterGeom {
  const depth = new Float32Array(WORLD_W * WORLD_H).fill(LAND);
  const deck = new Uint8Array(WORLD_W * WORLD_H);
  const mask = new Uint8Array(COLS * ROWS);
  const empty: WaterGeom = { cell: CELL, cols: COLS, rows: ROWS, mask, depth, deck, path: [], halfW: [], bridges: [], shine: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const route = routeRiver(places, seed ^ 0x717e);
  if (!route) return empty;
  const { path, halfW } = shapeRiver(route, seed);

  // stamp discs along the centreline: depth = how far inside the bank a pixel is
  let bx0 = WORLD_W;
  let by0 = WORLD_H;
  let bx1 = 0;
  let by1 = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i] as Pt;
    const b = path[i + 1] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 1.5));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      const r = (halfW[i] ?? 12) * (1 - t) + (halfW[i + 1] ?? 12) * t;
      const x0 = Math.max(0, Math.floor(cx - r - 1));
      const x1 = Math.min(WORLD_W - 1, Math.ceil(cx + r + 1));
      const y0 = Math.max(0, Math.floor(cy - r - 1));
      const y1 = Math.min(WORLD_H - 1, Math.ceil(cy + r + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = r - Math.hypot(x - cx, y - cy);
          const o = y * WORLD_W + x;
          if (v > (depth[o] ?? LAND)) depth[o] = v;
          if (v > -4) {
            if (x < bx0) bx0 = x;
            if (y < by0) by0 = y;
            if (x > bx1) bx1 = x;
            if (y > by1) by1 = y;
          }
        }
      }
    }
  }
  const bounds: Rect = bx1 > bx0 ? { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };

  // bridges where roads cross, and their decks
  const bridges: WaterBridge[] = [];
  for (const r of [...roads.main.values(), ...roads.side]) bridges.push(...roadBridges(r, depth));
  for (const b of bridges) forEachDeckPx(b, (x, y) => {
    if (x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H) deck[y * WORLD_W + x] = 1;
  });

  // coarse walk-block mask: open water only, decks carved out
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const x = Math.min(WORLD_W - 1, cx * CELL + CELL / 2);
      const y = Math.min(WORLD_H - 1, cy * CELL + CELL / 2);
      const o = y * WORLD_W + x;
      if ((depth[o] ?? LAND) > -1.5 && !deck[o]) mask[cy * COLS + cx] = 1;
    }
  }
  return { cell: CELL, cols: COLS, rows: ROWS, mask, depth, deck, path, halfW, bridges, shine: [], bounds };
}

// ── queries ──────────────────────────────────────────────────────────────────

/** True when (x, y) is river (or its bank, within `pad` px) and not on a bridge deck. */
export function waterAt(w: WaterGeom, x: number, y: number, pad = 0): boolean {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= WORLD_W || iy >= WORLD_H) return false;
  const o = iy * WORLD_W + ix;
  return !w.deck[o] && (w.depth[o] ?? LAND) > -pad;
}

/** True when any sampled point of `r` (grown by `pad` px) is water or bank. Bridge decks do not count. */
export function waterHitsRect(w: WaterGeom, r: Rect, pad = 0): boolean {
  if (w.bounds.w <= 0) return false;
  const b = w.bounds;
  if (r.x + r.w + pad < b.x || r.x - pad > b.x + b.w || r.y + r.h + pad < b.y || r.y - pad > b.y + b.h) return false;
  const x0 = Math.max(0, Math.floor(r.x - pad));
  const x1 = Math.min(WORLD_W - 1, Math.ceil(r.x + r.w + pad));
  const y0 = Math.max(0, Math.floor(r.y - pad));
  const y1 = Math.min(WORLD_H - 1, Math.ceil(r.y + r.h + pad));
  const thr = -pad;
  for (let y = y0; y <= y1; y += 2) {
    const row = y * WORLD_W;
    for (let x = x0; x <= x1; x += 2) if ((w.depth[row + x] ?? LAND) > thr && !w.deck[row + x]) return true;
  }
  return false;
}

// ── painting ─────────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];
const BANK_DARK: Rgb = [66, 54, 42];
const BANK_MUD: Rgb = [128, 102, 68];
const FOAM: Rgb = [178, 218, 234];
const SHALLOW: Rgb = [92, 168, 212];
const MID: Rgb = [58, 134, 194];
const DEEP: Rgb = [36, 100, 168];

const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Paints the river (banks, body, static shine, bridge shadows) then the bridges. Call after the roads, before the places. */
export function paintWater(ctx: CanvasRenderingContext2D, w: WaterGeom, seed: number): void {
  const b = w.bounds;
  if (b.w <= 0) return;
  const pad = 6;
  const x0 = Math.max(0, b.x - pad);
  const y0 = Math.max(0, b.y - pad);
  const bw = Math.min(WORLD_W, b.x + b.w + pad) - x0;
  const bh = Math.min(WORLD_H, b.y + b.h + pad) - y0;
  const img = new ImageData(bw, bh);
  const d = img.data;
  const s = seed ^ 0x3a7e;
  for (let y = 0; y < bh; y++) {
    const wy = y0 + y;
    for (let x = 0; x < bw; x++) {
      const wx = x0 + x;
      const o = wy * WORLD_W + wx;
      if (w.deck[o]) continue;
      // wobbly bank line: value noise nudges the signed depth
      const e = (w.depth[o] ?? LAND) + (vnoise2(wx / 5, wy / 5, s) - 0.5) * 2.2;
      if (e < -2.8) continue;
      let c: Rgb;
      let a = 255;
      if (e < -1.6) {
        c = BANK_DARK;
        a = 150;
      } else if (e < -0.2) c = BANK_MUD;
      else if (e < 0.9) c = FOAM;
      else if (e < 3.2) c = lerp(SHALLOW, MID, (e - 0.9) / 2.3);
      else c = lerp(MID, DEEP, Math.min(1, (e - 3.2) / 7));
      if (e > 0.9) {
        // soft horizontal ripples that drift with the flow noise
        const n = vnoise2(wx / 11, wy / 2.6, s ^ 9);
        if (n > 0.8) c = lerp(c, FOAM, 0.28);
        else if (n < 0.18) c = lerp(c, DEEP, 0.4);
        // the shade a bridge casts
        if (w.deck[Math.max(0, o - 2 * WORLD_W)] || w.deck[Math.max(0, o - 3 * WORLD_W)]) c = lerp(c, [16, 40, 70], 0.55);
      }
      const q = (y * bw + x) * 4;
      d[q] = Math.round(c[0]);
      d[q + 1] = Math.round(c[1]);
      d[q + 2] = Math.round(c[2]);
      d[q + 3] = a;
    }
  }
  // static shine: short light glints scattered over open water, a few brighter
  const rng = mulberry32(s ^ hash32('shine'));
  w.shine.length = 0;
  const target = Math.round((b.w * b.h) / 420);
  for (let i = 0; i < target * 4 && w.shine.length < target; i++) {
    const wx = x0 + 2 + Math.floor(rng() * (bw - 4));
    const wy = y0 + 1 + Math.floor(rng() * (bh - 2));
    const o = wy * WORLD_W + wx;
    if (w.deck[o] || (w.depth[o] ?? LAND) < 4) continue;
    if (w.deck[o - 2 * WORLD_W] || w.deck[o - 3 * WORLD_W]) continue;
    w.shine.push({ x: wx, y: wy });
    const hot = rng() < 0.3;
    const glint: Rgb = hot ? [236, 248, 255] : [170, 214, 236];
    for (let k = -1; k <= 1; k++) {
      const q = ((wy - y0) * bw + (wx - x0 + k)) * 4;
      d[q] = glint[0];
      d[q + 1] = glint[1];
      d[q + 2] = glint[2];
      d[q + 3] = hot || k === 0 ? 255 : 200;
    }
  }
  const cv = document.createElement('canvas');
  cv.width = bw;
  cv.height = bh;
  cv.getContext('2d')?.putImageData(img, 0, 0);
  ctx.drawImage(cv, x0, y0);

  paintBridges(ctx, w);
}

const PLANK_A = '#a67a48';
const PLANK_B = '#8f6538';
const SEAM = '#5e3f22';
const RAIL = '#4c321c';
const POST = '#c99a5e';

function paintBridges(ctx: CanvasRenderingContext2D, w: WaterGeom): void {
  for (const br of w.bridges) {
    const hw = br.width / 2;
    forEachDeckPx(br, (x, y, s, u) => {
      const au = Math.abs(u);
      let c: string;
      if (au > hw - 1.1) c = RAIL;
      else if (Math.floor(s) % 4 === 3) c = SEAM;
      else c = Math.floor(s / 4) % 2 === 0 ? PLANK_A : PLANK_B;
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 1, 1);
    });
    // rail posts: a lighter 2x2 cap every 9 px on both rails
    let s = 0;
    for (let i = 0; i < br.pts.length - 1; i++) {
      const a = br.pts[i] as Pt;
      const c = br.pts[i + 1] as Pt;
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      if (len < 0.01) continue;
      const tx = (c.x - a.x) / len;
      const ty = (c.y - a.y) / len;
      for (let l = 0; l < len; l += 1) {
        if (Math.floor(s + l) % 9 !== 2) continue;
        for (const side of [-1, 1]) {
          const px = Math.round(a.x + tx * l - ty * (hw - 0.5) * side);
          const py = Math.round(a.y + ty * l + tx * (hw - 0.5) * side);
          ctx.fillStyle = POST;
          ctx.fillRect(px - 1, py - 1, 2, 2);
        }
      }
      s += len;
    }
  }
}
