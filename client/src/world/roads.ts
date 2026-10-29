// Natural dirt roads: noise-displaced waypoints smoothed with Catmull-Rom, from
// the tavern plaza rim to every place, plus a few side paths between
// neighbours. Every road is rasterised into one signed-distance field (true
// distance to the centreline minus a constant half-width; junctions and the
// plaza blended with a smooth min) and painted from it as one textured ribbon.
// Deterministic from the layout (seeded by place ids).

import { WORLD_H, WORLD_W } from './constants';
import { catmullRom } from './geometry';
import type { PlaceGeom } from './places';
import { PLAZA_SQUASH } from './places';
import { hash32, mulberry32 } from './pixel';
import type { Pt, Rect } from './pixel';
import { DIRT, TILE_PX, drawTile, tilesetReady } from './tileset';

export interface Road {
  id: string;
  /** Place this road leads to (from the plaza). Side paths use `a->b`. */
  placeId: string;
  /** From the plaza rim to the place's gate (side paths: approach to approach). */
  pts: Pt[];
  /** Full ribbon width in px (constant apart from the mouths / end taper). */
  width: number;
  kind: 'main' | 'side';
}

/** Signed distance (px) to the nearest road edge for every world pixel; < 0 is on the road. */
export interface RoadField {
  sd: Float32Array;
  /** World rect holding every stamped road (the rest of the field is FAR). */
  bounds: Rect;
}

export interface RoadNet {
  /** Main roads keyed by place id. */
  main: Map<string, Road>;
  side: Road[];
  field: RoadField;
  seed: number;
}

export const MAIN_ROAD_W = 24;
export const WILD_ROAD_W = 22;
export const SIDE_PATH_W = 15;
/** Max px the painted ribbon reaches past the field's zero contour (edge noise + grass shade). */
export const ROAD_BLEED = 4;

/** Field value where nothing was stamped; values are exact up to REACH px off a road edge. */
const FAR = 64;
const REACH = 28;
/** Smooth-min radii: road-road junction fillets and the wider plaza mouths. */
const JOIN_K = 10;
const PLAZA_K = 22;
/** Extra half-width where a main road leaves the plaza / arrives at its gate. */
const MOUTH_PLAZA = 5;
const MOUTH_GATE = 4;
/** Painted-only run past the gate so the road tucks under the place art. */
const GATE_TUCK = 12;

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
    const start: Pt = { x: plaza.c.x + (dx / len) * (plaza.r + 2), y: plaza.c.y + (dy / len) * (plaza.r + 2) * PLAZA_SQUASH };
    const amp = Math.min(56, len * 0.14);
    const way = [...wavy(start, p.approach, rng, amp), p.gate];
    main.set(p.id, { id: p.id, placeId: p.id, pts: catmullRom(way, 5), width: p.kind === 'wild' ? WILD_ROAD_W : MAIN_ROAD_W, kind: 'main' });
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
    side.push({ id: key, placeId: key, pts: catmullRom(wavy(a.approach, best.approach, rng, Math.min(40, bestD * 0.12)), 5), width: SIDE_PATH_W, kind: 'side' });
  }
  const net: RoadNet = { main, side, field: { sd: new Float32Array(0), bounds: { x: 0, y: 0, w: 0, h: 0 } }, seed };
  net.field = buildField(net, tavern.plaza);
  return net;
}

// ── distance field ───────────────────────────────────────────────────────────

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Polynomial smooth min: rounds the crease where two shapes meet into a fillet about k px wide. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Arc length along a polyline at every point. */
function cumulative(pts: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    out.push((out[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return out;
}

/** Half-width at arc length `s`: constant, flared into mouths on main roads, slightly tapered at side-path ends. */
function profile(road: Road, len: number): (s: number) => number {
  const base = road.width / 2;
  if (road.kind === 'side') return (s) => base * (0.8 + 0.2 * smooth(Math.min(s, len - s) / 14));
  return (s) => base + MOUTH_PLAZA * (1 - smooth(s / 34)) + MOUTH_GATE * (1 - smooth((len - s) / 30));
}

/** Centreline as stamped: main roads run a few px past the gate so the end hides under the place art. */
function stampPts(road: Road): Pt[] {
  const pts = road.pts;
  if (road.kind !== 'main' || pts.length < 2) return pts;
  const a = pts[pts.length - 2] as Pt;
  const b = pts[pts.length - 1] as Pt;
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return [...pts, { x: b.x + ((b.x - a.x) / l) * GATE_TUCK, y: b.y + ((b.y - a.y) / l) * GATE_TUCK }];
}

function buildField(net: RoadNet, plaza: PlaceGeom['plaza']): RoadField {
  const sd = new Float32Array(WORLD_W * WORLD_H).fill(FAR);
  let bx0 = WORLD_W;
  let by0 = WORLD_H;
  let bx1 = 0;
  let by1 = 0;

  /** Merges a local field (rect x0..x1, y0..y1) into the world field with a smooth min. */
  const merge = (local: Float32Array, x0: number, y0: number, w: number, h: number, k: number): void => {
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * WORLD_W + x0;
      for (let x = 0; x < w; x++) {
        const v = local[y * w + x] ?? FAR;
        if (v >= FAR) continue;
        sd[row + x] = smin(sd[row + x] ?? FAR, v, k);
      }
    }
    bx0 = Math.min(bx0, x0);
    by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x0 + w);
    by1 = Math.max(by1, y0 + h);
  };

  const stamp = (road: Road): void => {
    const pts = stampPts(road);
    if (pts.length < 2) return;
    const cum = cumulative(pts);
    const hw = profile(road, cumulative(road.pts)[road.pts.length - 1] ?? 0);
    const pad = road.width / 2 + Math.max(MOUTH_PLAZA, MOUTH_GATE) + REACH;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const x0 = Math.max(0, Math.floor(minX - pad));
    const y0 = Math.max(0, Math.floor(minY - pad));
    const x1 = Math.min(WORLD_W, Math.ceil(maxX + pad));
    const y1 = Math.min(WORLD_H, Math.ceil(maxY + pad));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const local = new Float32Array(w * h).fill(FAR);
    // hard min over the road's own segments (a smooth min there would bulge at every vertex)
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i] as Pt;
      const b = pts[i + 1] as Pt;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      const len = Math.sqrt(len2);
      const s0 = cum[i] ?? 0;
      const sx0 = Math.max(x0, Math.floor(Math.min(a.x, b.x) - pad));
      const sx1 = Math.min(x1, Math.ceil(Math.max(a.x, b.x) + pad));
      const sy0 = Math.max(y0, Math.floor(Math.min(a.y, b.y) - pad));
      const sy1 = Math.min(y1, Math.ceil(Math.max(a.y, b.y) + pad));
      for (let y = sy0; y < sy1; y++) {
        const py = y + 0.5;
        for (let x = sx0; x < sx1; x++) {
          const px = x + 0.5;
          const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
          const v = Math.hypot(a.x + dx * t - px, a.y + dy * t - py) - hw(s0 + t * len);
          const li = (y - y0) * w + (x - x0);
          if (v < (local[li] ?? FAR)) local[li] = v;
        }
      }
    }
    merge(local, x0, y0, w, h, JOIN_K);
  };

  for (const r of net.side) stamp(r);
  for (const r of net.main.values()) stamp(r);

  // the plaza joins in last with a wider radius: rounded, widened mouths where roads meet it
  if (plaza) {
    const rx = plaza.r;
    const ry = plaza.r * PLAZA_SQUASH;
    const x0 = Math.max(0, Math.floor(plaza.c.x - rx - REACH));
    const y0 = Math.max(0, Math.floor(plaza.c.y - ry - REACH));
    const x1 = Math.min(WORLD_W, Math.ceil(plaza.c.x + rx + REACH));
    const y1 = Math.min(WORLD_H, Math.ceil(plaza.c.y + ry + REACH));
    const w = x1 - x0;
    const h = y1 - y0;
    const local = new Float32Array(Math.max(0, w * h));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // approximate ellipse distance (exact on the axes, close near the rim)
        const qx = x0 + x + 0.5 - plaza.c.x;
        const qy = y0 + y + 0.5 - plaza.c.y;
        const k0 = Math.hypot(qx / rx, qy / ry);
        const k1 = Math.hypot(qx / (rx * rx), qy / (ry * ry));
        local[y * w + x] = k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -ry;
      }
    }
    if (w > 0 && h > 0) merge(local, x0, y0, w, h, PLAZA_K);
  }

  const bounds = bx1 > bx0 && by1 > by0 ? { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } : { x: 0, y: 0, w: 0, h: 0 };
  return { sd, bounds };
}

/** Signed distance (px) from (x, y) to the nearest road edge; negative on the road. */
export function roadSdAt(net: RoadNet, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= WORLD_W || iy >= WORLD_H) return FAR;
  return net.field.sd[iy * WORLD_W + ix] ?? FAR;
}

/** True when (x, y) lies within `margin` px of any road edge (or on a road). */
export function nearRoad(net: RoadNet, x: number, y: number, margin: number): boolean {
  return roadSdAt(net, x, y) < margin;
}

/** True when any pixel of `r` lies within `margin` px of a road edge. */
export function rectNearRoad(net: RoadNet, r: Rect, margin: number): boolean {
  // quick reject from the centre (the field changes by at most ~1.25 px per px)
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (Math.min(roadSdAt(net, cx, cy), REACH) - 1.25 * Math.hypot(r.w / 2, r.h / 2) >= margin) return false;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(WORLD_W, Math.ceil(r.x + r.w));
  const y1 = Math.min(WORLD_H, Math.ceil(r.y + r.h));
  const sd = net.field.sd;
  for (let y = y0; y < y1; y++) {
    const row = y * WORLD_W;
    for (let x = x0; x < x1; x++) if ((sd[row + x] ?? FAR) < margin) return true;
  }
  return false;
}

/** Cells (cols x rows of `cell` px) holding any painted road pixel. */
export function roadMask(net: RoadNet, cols: number, rows: number, cell: number): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (rectNearRoad(net, { x: tx * cell, y: ty * cell, w: cell, h: cell }, ROAD_BLEED)) mask[ty * cols + tx] = 1;
    }
  }
  return mask;
}

// ── painting ─────────────────────────────────────────────────────────────────

/** Integer lattice hash in [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1]. */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

/** Deterministic ±2 px wobble of the road outline so it reads trodden, not vector-perfect. */
function edgeNoise(x: number, y: number, seed: number): number {
  const n = 1.5 * vnoise(x / 9, y / 9, seed ^ 0x1e) + 0.7 * vnoise(x / 3.2, y / 3.2, seed ^ 0x2f);
  return Math.max(-2, Math.min(2, n));
}

/** Short vertical grass blades poking over the dirt edge (3 px tall, column-staggered). */
function blade(x: number, y: number, seed: number): boolean {
  const g = Math.floor((y + Math.floor(hash2(x, 0, seed ^ 0xb1) * 3)) / 3);
  return hash2(x, g, seed ^ 0xb2) < 0.2;
}

/** Inside-edge band that darkens (px), how dark it gets at the outline, and the grass-blade band. */
const EDGE_BAND = 3;
const EDGE_ALPHA = 0.56;
const EDGE_RGB = [104, 66, 36] as const;
const BLADE_BAND = 1.8;
/** Grass-side contact shade just outside the dirt. */
const SHADE_BAND = 1.6;
const SHADE_ALPHA = 0.2;
const SHADE_RGB = [28, 52, 18] as const;

/** True when the ribbon (dirt or its grass shade) covers world pixel (x, y): what decor must avoid. */
export function roadPaintedAt(net: RoadNet, x: number, y: number): boolean {
  const sd = roadSdAt(net, x, y);
  if (sd >= ROAD_BLEED) return false;
  return sd + edgeNoise(Math.floor(x), Math.floor(y), net.seed) < SHADE_BAND;
}

/** 128 px repeat of the atlas dirt (mostly the plain blob centre, a few pebbled variants); flat pixel dirt before the atlas loads. */
function dirtTile(seed: number): HTMLCanvasElement {
  const n = 8;
  const cv = document.createElement('canvas');
  cv.width = n * TILE_PX;
  cv.height = n * TILE_PX;
  const c = cv.getContext('2d');
  if (!c) return cv;
  const rng = mulberry32(seed ^ 0xd127);
  if (tilesetReady()) {
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const ref = DIRT.plain[Math.floor(rng() * DIRT.plain.length)] ?? DIRT.blob;
        drawTile(c, ref, tx * TILE_PX, ty * TILE_PX);
      }
    }
    return cv;
  }
  c.fillStyle = '#d9b380';
  c.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 260; i++) {
    c.fillStyle = rng() < 0.55 ? '#c9a06b' : '#e4c794';
    c.fillRect(Math.floor(rng() * cv.width), Math.floor(rng() * cv.height), 2, 1 + Math.floor(rng() * 2));
  }
  return cv;
}

/** Writes one RGBA pixel unless a stronger one is already there (so overlapping stamps never double up). */
function put(d: Uint8ClampedArray, o: number, r: number, g: number, b: number, a: number): void {
  if (a <= (d[o + 3] ?? 0)) return;
  d[o] = r;
  d[o + 1] = g;
  d[o + 2] = b;
  d[o + 3] = a;
}

/** Point + unit tangent at arc length `s` along a polyline. */
function along(pts: Pt[], cum: number[], s: number): { x: number; y: number; tx: number; ty: number } {
  let i = 0;
  while (i < pts.length - 2 && (cum[i + 1] ?? 0) < s) i++;
  const a = pts[i] as Pt;
  const b = (pts[i + 1] ?? a) as Pt;
  const l = Math.max(1e-6, (cum[i + 1] ?? 0) - (cum[i] ?? 0));
  const t = Math.max(0, Math.min(1, (s - (cum[i] ?? 0)) / l));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx: (b.x - a.x) / l, ty: (b.y - a.y) / l };
}

/**
 * Paints every road as one continuous ribbon: the dirt texture masked by the
 * noisy field outline, a darker worn inner edge, grass blades over the edge, a
 * soft grass shade outside it, and sparse wheel ruts + pebbles. Call once per
 * world paint, before the place art.
 */
export function paintRoads(ctx: CanvasRenderingContext2D, net: RoadNet): void {
  const { sd } = net.field;
  const { x: bx, y: by, w: bw, h: bh } = net.field.bounds;
  if (bw <= 0 || bh <= 0) return;
  const seed = net.seed;
  const mask = new ImageData(bw, bh);
  const wear = new ImageData(bw, bh);
  const fringe = new ImageData(bw, bh);
  const md = mask.data;
  const wd = wear.data;
  const fd = fringe.data;
  for (let y = 0; y < bh; y++) {
    const wy = by + y;
    for (let x = 0; x < bw; x++) {
      const wx = bx + x;
      const v = sd[wy * WORLD_W + wx] ?? FAR;
      if (v >= ROAD_BLEED) continue;
      const e = v + edgeNoise(wx, wy, seed);
      const o = (y * bw + x) * 4;
      if (e >= 0) {
        if (e < SHADE_BAND) put(fd, o, SHADE_RGB[0], SHADE_RGB[1], SHADE_RGB[2], Math.round(255 * SHADE_ALPHA * (1 - e / SHADE_BAND)));
        continue;
      }
      // grass blades overlapping the edge: leave the grass showing
      if (e > -BLADE_BAND && blade(wx, wy, seed)) continue;
      md[o + 3] = 255;
      if (e > -EDGE_BAND) {
        const t = 1 + e / EDGE_BAND;
        put(wd, o, EDGE_RGB[0], EDGE_RGB[1], EDGE_RGB[2], Math.round(255 * EDGE_ALPHA * t * t));
      }
    }
  }

  const local = (wx: number, wy: number): number => {
    const x = Math.floor(wx) - bx;
    const y = Math.floor(wy) - by;
    return x < 0 || y < 0 || x >= bw || y >= bh ? -1 : (y * bw + x) * 4;
  };
  const inner = (wx: number, wy: number, depth: number): boolean => roadSdAt(net, wx, wy) + edgeNoise(Math.floor(wx), Math.floor(wy), seed) < -depth;

  // wheel ruts: now and then a faint pair of tracks along a stretch of a main road
  for (const road of net.main.values()) {
    const rng = mulberry32(seed ^ hash32(road.id) ^ 0x7275);
    const cum = cumulative(road.pts);
    const L = cum[cum.length - 1] ?? 0;
    if (rng() > 0.7) continue;
    const l = 46 + rng() * 54;
    if (L < l + 90) continue;
    const sa = 45 + rng() * (L - l - 90);
    const off = road.width * 0.21;
    for (let s = sa; s <= sa + l; s += 0.5) {
      const p = along(road.pts, cum, s);
      const env = Math.sin(((s - sa) / l) * Math.PI);
      for (const side of [-1, 1]) {
        const qx = p.x - p.ty * off * side;
        const qy = p.y + p.tx * off * side;
        if (vnoise(s / 7, side * 5, seed ^ 0x3a) < -0.55 || !inner(qx, qy, 3)) continue;
        const o = local(qx, qy);
        if (o >= 0) put(wd, o, 98, 62, 32, Math.round(255 * 0.3 * Math.pow(env, 0.6)));
        const h = local(qx, qy + 1);
        if (h >= 0) put(wd, h, 238, 210, 156, Math.round(255 * 0.16 * Math.pow(env, 0.6)));
      }
    }
  }

  // a few small pebbles, more on the main roads
  const pebble = (wx: number, wy: number, big: boolean): void => {
    const w = big ? 3 : 2;
    for (let dx = 0; dx < w; dx++) {
      const top = local(wx + dx, wy);
      const bot = local(wx + dx, wy + 1);
      const sh = local(wx + dx, wy + 2);
      if (top >= 0) {
        if (dx === 0) put(wd, top, 204, 196, 178, 255);
        else put(wd, top, 166, 157, 140, 255);
      }
      if (bot >= 0) put(wd, bot, 124, 116, 101, 255);
      if (sh >= 0) put(wd, sh, 92, 60, 32, 70);
    }
  };
  const roads = [...net.main.values(), ...net.side];
  for (const road of roads) {
    const rng = mulberry32(seed ^ hash32(road.id) ^ 0x9e3779b9);
    const cum = cumulative(road.pts);
    const L = cum[cum.length - 1] ?? 0;
    const step = road.kind === 'main' ? 34 : 52;
    const chance = road.kind === 'main' ? 0.5 : 0.25;
    for (let s = 20 + rng() * step; s < L - 20; s += step * (0.7 + rng() * 0.6)) {
      if (rng() > chance) continue;
      const p = along(road.pts, cum, s);
      const u = (rng() * 2 - 1) * (road.width / 2 - 5);
      const qx = Math.round(p.x - p.ty * u);
      const qy = Math.round(p.y + p.tx * u);
      if (inner(qx, qy, 4) && inner(qx + 3, qy + 2, 4)) pebble(qx, qy, rng() < 0.45);
    }
  }

  // compose: dirt pattern ∩ mask, wear on top of the dirt only, then the grass-side shade
  const toCanvas = (img: ImageData): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    cv.getContext('2d')?.putImageData(img, 0, 0);
    return cv;
  };
  const dirt = document.createElement('canvas');
  dirt.width = bw;
  dirt.height = bh;
  const dc = dirt.getContext('2d');
  const pattern = dc?.createPattern(dirtTile(seed), 'repeat');
  if (!dc || !pattern) return;
  dc.imageSmoothingEnabled = false;
  // pattern anchored to the world origin so the texture never shifts between roads
  dc.translate(-bx, -by);
  dc.fillStyle = pattern;
  dc.fillRect(bx, by, bw, bh);
  dc.setTransform(1, 0, 0, 1, 0, 0);
  dc.globalCompositeOperation = 'destination-in';
  dc.drawImage(toCanvas(mask), 0, 0);
  dc.globalCompositeOperation = 'source-atop';
  dc.drawImage(toCanvas(wear), 0, 0);
  dc.globalCompositeOperation = 'source-over';
  ctx.drawImage(toCanvas(fringe), bx, by);
  ctx.drawImage(dirt, bx, by);
}
