// Biomes: soft-blended ground character per region, derived from every place's
// geometry (never from fixed coordinates, so dragged places carry their biome).
//   stone    - grey highlands around cities (SIF)
//   lush     - green farmland around towns (HABITS)
//   badlands - dark rocky dirt around dungeons (Momma Mia)
//   scorched - ash + lava cracks around lairs (Simone)
//   meadow   - flowery grass around wild places (Village, Portfolio)
//   worn     - trodden grass around the tavern plaza
// The ground is tinted by one RGBA overlay (no pixel read-back, so it also works
// on a tainted canvas under file://) composited over the LPC grass.

import { WORLD_H, WORLD_W } from './constants';
import { hash32, mulberry32 } from './pixel';
import type { Pt, Rect } from './pixel';
import type { PlaceGeom } from './places';

export type BiomeId = 'base' | 'stone' | 'lush' | 'badlands' | 'scorched' | 'meadow' | 'worn';
export const BIOME_IDS: BiomeId[] = ['base', 'stone', 'lush', 'badlands', 'scorched', 'meadow', 'worn'];
const NB = BIOME_IDS.length;
const IDX: Record<BiomeId, number> = { base: 0, stone: 1, lush: 2, badlands: 3, scorched: 4, meadow: 5, worn: 6 };

/** Which biome a place radiates. */
export function biomeOfPlace(g: PlaceGeom): BiomeId {
  if (g.kind === 'tavern') return 'worn';
  if (g.kind === 'dungeon') return 'badlands';
  if (g.kind === 'lair') return 'scorched';
  if (g.kind === 'city') return g.id === 'habits' ? 'lush' : 'stone';
  return g.landmark === 'stones' || g.landmark === 'ruins' ? 'stone' : 'meadow';
}

/** Blend weights on a coarse grid (sum to 1 per cell); `w[(cy*cols+cx)*NB + biomeIndex]`. */
export interface BiomeField {
  cell: number;
  cols: number;
  rows: number;
  w: Float32Array;
  seed: number;
}

const CELL = 8;

// ── noise ────────────────────────────────────────────────────────────────────

function hnoise(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise in 0..1. */
export function vnoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hnoise(ix, iy, seed);
  const b = hnoise(ix + 1, iy, seed);
  const c = hnoise(ix, iy + 1, seed);
  const d = hnoise(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function distRect(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

// ── field ────────────────────────────────────────────────────────────────────

export function buildBiomes(places: PlaceGeom[], seed: number): BiomeField {
  const cols = Math.ceil(WORLD_W / CELL);
  const rows = Math.ceil(WORLD_H / CELL);
  const w = new Float32Array(cols * rows * NB);
  const s = (seed ^ 0xb10e) | 0;
  const infl = places.map((g) => ({ g, b: IDX[biomeOfPlace(g)], R: g.kind === 'tavern' ? 70 : g.kind === 'wild' ? 120 : 150 }));
  const f = new Float32Array(infl.length);
  for (let cy = 0; cy < rows; cy++) {
    const y = cy * CELL + CELL / 2;
    for (let cx = 0; cx < cols; cx++) {
      const x = cx * CELL + CELL / 2;
      // two noise octaves push the borders about, so regions never read as clean circles
      const n = vnoise2(x / 70, y / 70, s) * 0.7 + vnoise2(x / 23, y / 23, s ^ 77) * 0.3 - 0.5;
      let sum = 0;
      for (let i = 0; i < infl.length; i++) {
        const it = infl[i] as (typeof infl)[number];
        const g = it.g;
        let d: number;
        if (g.kind === 'tavern' && g.plaza) d = Math.max(0, Math.hypot(x - g.plaza.c.x, (y - g.plaza.c.y) / 0.82) - g.plaza.r);
        else d = distRect(x, y, g.rect);
        const t = 1 - (d + n * 70) / it.R;
        const v = smoothstep(t);
        f[i] = v;
        sum += v;
      }
      const o = (cy * cols + cx) * NB;
      const norm = sum > 1 ? 1 / sum : 1;
      let used = 0;
      for (let i = 0; i < infl.length; i++) {
        const it = infl[i] as (typeof infl)[number];
        const v = (f[i] ?? 0) * norm;
        w[o + it.b] = (w[o + it.b] ?? 0) + v;
        used += v;
      }
      w[o] = Math.max(0, 1 - used);
    }
  }
  return { cell: CELL, cols, rows, w, seed: s };
}

export function biomeWeightsAt(f: BiomeField, x: number, y: number, out: Float32Array = new Float32Array(NB)): Float32Array {
  const cx = Math.max(0, Math.min(f.cols - 1, Math.floor(x / f.cell)));
  const cy = Math.max(0, Math.min(f.rows - 1, Math.floor(y / f.cell)));
  const o = (cy * f.cols + cx) * NB;
  for (let i = 0; i < NB; i++) out[i] = f.w[o + i] ?? 0;
  return out;
}

export function biomeWeight(f: BiomeField, x: number, y: number, id: BiomeId): number {
  const cx = Math.max(0, Math.min(f.cols - 1, Math.floor(x / f.cell)));
  const cy = Math.max(0, Math.min(f.rows - 1, Math.floor(y / f.cell)));
  return f.w[(cy * f.cols + cx) * NB + IDX[id]] ?? 0;
}

/** Strongest biome at a world point. */
export function dominantBiome(f: BiomeField, x: number, y: number): BiomeId {
  const w = biomeWeightsAt(f, x, y);
  let best = 0;
  for (let i = 1; i < NB; i++) if ((w[i] ?? 0) > (w[best] ?? 0)) best = i;
  return BIOME_IDS[best] ?? 'base';
}

// ── ground tint overlay ──────────────────────────────────────────────────────

type Rgb = readonly [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const STONE_A: Rgb = [112, 116, 114];
const STONE_B: Rgb = [146, 148, 142];
const STONE_DARK: Rgb = [84, 88, 90];
const BAD_A: Rgb = [92, 68, 50];
const BAD_B: Rgb = [66, 48, 38];
const BAD_LIGHT: Rgb = [122, 96, 72];
const ASH_A: Rgb = [58, 52, 50];
const ASH_B: Rgb = [92, 84, 78];
const ASH_DARK: Rgb = [34, 30, 30];
const LUSH_A: Rgb = [48, 150, 48];
const LUSH_B: Rgb = [92, 188, 60];
const MEADOW_A: Rgb = [140, 200, 84];
const MEADOW_B: Rgb = [186, 218, 98];
const WORN_A: Rgb = [166, 150, 84];
const WORN_B: Rgb = [146, 126, 78];

export const LAVA_CORE: Rgb = [255, 168, 48];
export const LAVA_MID: Rgb = [232, 84, 22];
export const LAVA_EDGE: Rgb = [70, 24, 16];

/** acc = [R*a, G*a, B*a, A] running sums for one block. */
function accAdd(acc: Float64Array, wt: number, alpha: number, c: Rgb): void {
  const a = wt * alpha;
  if (a <= 0.003) return;
  acc[3] = (acc[3] as number) + a;
  acc[0] = (acc[0] as number) + c[0] * a;
  acc[1] = (acc[1] as number) + c[1] * a;
  acc[2] = (acc[2] as number) + c[2] * a;
}

/**
 * Builds the full-world RGBA tint overlay (alpha = biome strength) and draws it on `ctx`.
 * Also stamps lava veins in the scorched zone and sparse flowers in meadows / farmland.
 */
export function paintBiomeOverlay(ctx: CanvasRenderingContext2D, f: BiomeField): void {
  const img = new ImageData(WORLD_W, WORLD_H);
  const d = img.data;
  const sd = f.seed;
  const w = new Float32Array(NB);
  const acc = new Float64Array(4);
  const nPatch = new Float32Array(WORLD_W / 2 + 1);
  const nBig = new Float32Array(WORLD_W / 2 + 1);
  const nStone = new Float32Array(WORLD_W / 2 + 1);
  const nBad = new Float32Array(WORLD_W / 2 + 1);
  const nLava = new Float32Array(WORLD_W / 2 + 1);
  for (let y = 0; y < WORLD_H; y += 2) {
    for (let x = 0; x < WORLD_W; x += 2) {
      biomeWeightsAt(f, x, y, w);
      const wst = w[1] ?? 0;
      const wlu = w[2] ?? 0;
      const wba = w[3] ?? 0;
      const wsc = w[4] ?? 0;
      const wme = w[5] ?? 0;
      const wwo = w[6] ?? 0;
      if (wst + wlu + wba + wsc + wme + wwo < 0.02) continue;
      const g = hnoise(x, y, sd ^ 0x9e37);
      // value-noise fields are sampled once per 2x2 block (chunky pixel-art texture, ~4x cheaper); grain stays per pixel
      const k = x >> 1;
      {
        nPatch[k] = vnoise2(x / 9, y / 9, sd ^ 11);
        nBig[k] = vnoise2(x / 31, y / 31, sd ^ 23);
        nStone[k] = wst > 0.01 ? Math.abs(vnoise2(x / 14, y / 14, sd ^ 5) - 0.5) : 1;
        nBad[k] = wba > 0.01 ? Math.abs(vnoise2(x / 11, y / 11, sd ^ 91) - 0.5) : 1;
        nLava[k] = wsc > 0.45 ? Math.abs(vnoise2(x / 26, y / 26, sd ^ 313) - 0.5) : 1;
      }
      const patch = nPatch[k] ?? 0;
      const big = nBig[k] ?? 0;
      acc[0] = 0;
      acc[1] = 0;
      acc[2] = 0;
      acc[3] = 0;
      if (wst > 0.01) {
        let c = mix(STONE_A, STONE_B, patch * 0.7 + big * 0.5 - 0.2);
        // flagstone-ish cracks and pebbles
        const crack = nStone[k] ?? 1;
        if (crack < 0.018) c = mix(c, STONE_DARK, 0.8);
        else if (g > 0.965) c = mix(c, STONE_B, 0.9);
        else if (g < 0.04) c = mix(c, STONE_DARK, 0.7);
        accAdd(acc, wst, 0.93, mix(c, [c[0] + 6, c[1] + 6, c[2] + 6], g - 0.5));
      }
      if (wba > 0.01) {
        let c = mix(BAD_B, BAD_A, patch * 0.8 + big * 0.4 - 0.1);
        const crack = nBad[k] ?? 1;
        if (crack < 0.02) c = mix(c, [40, 28, 24], 0.85);
        else if (g > 0.95) c = BAD_LIGHT;
        else if (g < 0.05) c = mix(c, [44, 32, 28], 0.8);
        accAdd(acc, wba, 0.94, c);
      }
      if (wsc > 0.01) {
        let c = mix(ASH_A, ASH_B, patch * 0.8 + big * 0.5 - 0.3);
        if (g > 0.97) c = ASH_B;
        else if (g < 0.06) c = ASH_DARK;
        let a = 0.96;
        // lava veins: thin ridges of a slow noise field, only deep in the scorched zone
        if (wsc > 0.45) {
          const t = nLava[k] ?? 1;
          const fade = smoothstep((wsc - 0.45) / 0.3);
          if (t < 0.012 * fade + 0.0001) c = mix(LAVA_MID, LAVA_CORE, patch);
          else if (t < 0.03 * fade) c = mix(LAVA_EDGE, c, 0.25);
        }
        accAdd(acc, wsc, a, c);
      }
      if (wlu > 0.01) accAdd(acc, wlu, 0.42 + patch * 0.12, mix(LUSH_A, LUSH_B, patch));
      if (wme > 0.01) accAdd(acc, wme, 0.4, mix(MEADOW_A, MEADOW_B, patch));
      if (wwo > 0.01) {
        let c = mix(WORN_A, WORN_B, patch);
        if (g > 0.93) c = [150, 118, 82];
        accAdd(acc, wwo, 0.42, c);
      }
      if ((acc[3] as number) <= 0.003) continue;
      const A = acc[3] as number;
      const r0 = (acc[0] as number) / A;
      const g0 = (acc[1] as number) / A;
      const b0 = (acc[2] as number) / A;
      const a0 = Math.round(Math.min(1, A) * 255);
      // the 2x2 block shares one colour; a small per-pixel jitter keeps the grain
      for (let q = 0; q < 4; q++) {
        const px = x + (q & 1);
        const py = y + (q >> 1);
        const j = (hnoise(px, py, sd ^ 0x51) - 0.5) * 9;
        const o = (py * WORLD_W + px) * 4;
        d[o] = r0 + j;
        d[o + 1] = g0 + j;
        d[o + 2] = b0 + j;
        d[o + 3] = a0;
      }
    }
  }
  const cv = document.createElement('canvas');
  cv.width = WORLD_W;
  cv.height = WORLD_H;
  const c2 = cv.getContext('2d');
  if (!c2) return;
  c2.putImageData(img, 0, 0);
  ctx.drawImage(cv, 0, 0);
}

const FLOWER_COLORS = ['#f6f3ea', '#f2c14e', '#e2737f', '#e8a2c8', '#b9a2ee'];

/** Tiny pixel flowers sprinkled on meadow / farmland ground (later layers cover them where roads, water or places sit). */
export function paintGroundFlowers(ctx: CanvasRenderingContext2D, f: BiomeField): void {
  const rng = mulberry32(f.seed ^ 0xf10e);
  const w = new Float32Array(NB);
  for (let i = 0; i < 9000; i++) {
    const x = 4 + Math.floor(rng() * (WORLD_W - 8));
    const y = 4 + Math.floor(rng() * (WORLD_H - 8));
    biomeWeightsAt(f, x, y, w);
    const m = (w[5] ?? 0) * 1 + (w[2] ?? 0) * 0.55;
    // clumpy: gated by a noise field so flowers gather in drifts
    const clump = vnoise2(x / 24, y / 24, f.seed ^ 0xc1) ;
    if (rng() > m * (0.4 + clump * 1.2) || clump < 0.3) continue;
    const col = FLOWER_COLORS[Math.floor(clump * 7 + rng() * 2) % FLOWER_COLORS.length] ?? '#f6f3ea';
    ctx.fillStyle = '#3f7a2c';
    ctx.fillRect(x, y + 1, 1, 2);
    ctx.fillStyle = col;
    ctx.fillRect(x - 1, y, 3, 1);
    ctx.fillRect(x, y - 1, 1, 3);
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(x, y, 1, 1);
  }
}

// ── lava pools ───────────────────────────────────────────────────────────────

export interface LavaPool {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/**
 * A few lava pools in the scorched zone, just outside every lair. `ok` vetoes a pool's bounding box
 * (roads, other places, plaza, water). Deterministic from the place id.
 */
export function placeLavaPools(places: PlaceGeom[], seed: number, ok: (box: Rect) => boolean): LavaPool[] {
  const pools: LavaPool[] = [];
  for (const g of places) {
    if (biomeOfPlace(g) !== 'scorched') continue;
    const rng = mulberry32(seed ^ hash32(g.id) ^ 0x1a7a);
    const r = g.rect;
    let n = 0;
    for (let i = 0; i < 160 && n < 4; i++) {
      const rx = 14 + Math.floor(rng() * 14);
      const ry = 8 + Math.floor(rng() * 8);
      const side = Math.floor(rng() * 4);
      const along = rng();
      const out = 12 + rng() * 60;
      const x = side === 0 || side === 2 ? r.x + along * r.w : side === 1 ? r.x + r.w + out + rx : r.x - out - rx;
      const y = side === 1 || side === 3 ? r.y + along * r.h : side === 2 ? r.y + r.h + out + ry : r.y - out - ry;
      const box: Rect = { x: Math.round(x) - rx - 4, y: Math.round(y) - ry - 4, w: 2 * rx + 8, h: 2 * ry + 8 };
      if (!ok(box)) continue;
      if (pools.some((p) => Math.abs(p.x - x) < p.rx + rx + 10 && Math.abs(p.y - y) < p.ry + ry + 8)) continue;
      pools.push({ x: Math.round(x), y: Math.round(y), rx, ry });
      n++;
    }
  }
  return pools;
}

/** Static pixel-art lava pool: charred rim, orange body, hot streaks. Edge wobbles with noise. */
export function paintLavaPools(ctx: CanvasRenderingContext2D, pools: LavaPool[], seed: number): void {
  const px = (x: number, y: number, c: Rgb): void => {
    ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    ctx.fillRect(x, y, 1, 1);
  };
  for (const p of pools) {
    const wob = (x: number, y: number): number => 1 + (vnoise2(x / 6, y / 6, seed ^ 0x77) - 0.5) * 0.5;
    for (let y = p.y - p.ry - 6; y <= p.y + p.ry + 6; y++) {
      for (let x = p.x - p.rx - 6; x <= p.x + p.rx + 6; x++) {
        const k = Math.hypot((x - p.x) / p.rx, (y - p.y) / p.ry) / wob(x, y);
        if (k > 1.32) continue;
        if (k > 1.12) {
          if (hnoise(x, y, seed) < 0.75) px(x, y, [44, 36, 34]);
        } else if (k > 1) px(x, y, LAVA_EDGE);
        else if (k > 0.86) px(x, y, [196, 58, 20]);
        else {
          const s = vnoise2(x / 5 + 100, y / 3, seed ^ 0x31);
          px(x, y, s > 0.66 ? LAVA_CORE : s > 0.4 ? LAVA_MID : [214, 66, 20]);
        }
      }
    }
  }
}

export type { Pt };
