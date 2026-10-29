// Builds the static world layer once per layout: grass, roads, every place's
// art and the scattered decorations. Returns the geometry the live layers need
// (place geoms, roads, sway tufts, pond, window glows).

import type { PlaceDef } from './registry';
import { TAVERN_PLACE } from './registry';
import { DEFAULT_PLACE_TILES, TILE, WILD_SLOTS, WORLD_H, WORLD_SEED, WORLD_W, footprintFor } from './constants';
import type { TilePos } from './constants';
import { rectsOverlap } from './geometry';
import { computePlaceGeom, drawPlaceStatic, drawTree } from './places';
import type { PlaceGeom } from './places';
import { drawPixelDisc, drawPixelEllipse, mulberry32 } from './pixel';
import type { Pt, Rect } from './pixel';
import { buildRoads, nearRoad, paintRoad } from './roads';
import type { RoadNet } from './roads';

export type LayoutTiles = Record<string, TilePos>;

export interface World {
  canvas: HTMLCanvasElement;
  tavern: PlaceGeom;
  places: PlaceGeom[];
  byId: Map<string, PlaceGeom>;
  roads: RoadNet;
  tufts: Pt[];
  pond: { x: number; y: number; rx: number; ry: number } | null;
}

/** Resolve every place's tile position: saved layout → static default → next free wild slot. */
export function resolveTiles(defs: PlaceDef[], layout: LayoutTiles): Map<string, TilePos> {
  const out = new Map<string, TilePos>();
  const taken: Rect[] = [];
  const claim = (def: PlaceDef, tile: TilePos): void => {
    const fp = footprintFor(def.kind, def.id);
    out.set(def.id, tile);
    taken.push({ x: tile.tx, y: tile.ty, w: fp.tw, h: fp.th });
  };
  claim(TAVERN_PLACE, layout['tavern'] ?? DEFAULT_PLACE_TILES['tavern'] ?? { tx: 42, ty: 26 });
  const pending: PlaceDef[] = [];
  for (const def of defs) {
    const saved = layout[def.id] ?? DEFAULT_PLACE_TILES[def.id];
    if (saved) claim(def, saved);
    else pending.push(def);
  }
  for (const def of pending) {
    const fp = footprintFor(def.kind, def.id);
    const slot = WILD_SLOTS.find((s) => !taken.some((r) => rectsOverlap(r, { x: s.tx, y: s.ty, w: fp.tw, h: fp.th })));
    claim(def, slot ?? { tx: 2, ty: 2 });
  }
  return out;
}

export function buildWorld(defs: PlaceDef[], layout: LayoutTiles): World {
  const tiles = resolveTiles(defs, layout);
  const tavern = computePlaceGeom(TAVERN_PLACE, tiles.get('tavern') ?? { tx: 42, ty: 26 });
  const places: PlaceGeom[] = [tavern, ...defs.map((d) => computePlaceGeom(d, tiles.get(d.id) ?? { tx: 2, ty: 2 }))];
  const byId = new Map(places.map((p) => [p.id, p]));
  const roads = buildRoads(tavern, places, WORLD_SEED);

  const cv = document.createElement('canvas');
  cv.width = WORLD_W;
  cv.height = WORLD_H;
  const ctx = cv.getContext('2d');
  const world: World = { canvas: cv, tavern, places, byId, roads, tufts: [], pond: null };
  if (!ctx) return world;
  ctx.imageSmoothingEnabled = false;
  const rng = mulberry32(WORLD_SEED);

  // ── grass: warm tones from layered sines + dither ──
  const s1 = rng() * Math.PI * 2;
  const s2 = rng() * Math.PI * 2;
  const s3 = rng() * Math.PI * 2;
  ctx.fillStyle = '#7ab548';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  for (let y = 0; y < WORLD_H; y += 4) {
    for (let x = 0; x < WORLD_W; x += 4) {
      const v =
        Math.sin(x * 0.021 + s1) +
        Math.sin(y * 0.027 + s2) +
        Math.sin((x * 0.6 + y) * 0.016 + s3) +
        Math.sin((x - y * 0.7) * 0.012 + s1) +
        (rng() - 0.5) * 0.9;
      let tone: string | null = null;
      if (v < -1.4) tone = '#6da33f';
      else if (v > 1.8) tone = '#99cb5c';
      else if (v > 0.5) tone = '#8bc34a';
      if (tone) {
        ctx.fillStyle = tone;
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(rng() * WORLD_W);
    const y = Math.floor(rng() * WORLD_H);
    const k = rng();
    if (k < 0.42) {
      ctx.fillStyle = rng() < 0.5 ? '#67a03b' : '#a8d472';
      ctx.fillRect(x, y, 1, 3);
      ctx.fillRect(x + 2, y + 1, 1, 2);
    } else if (k < 0.78) {
      ctx.fillStyle = rng() < 0.5 ? '#8ec558' : '#71aa42';
      ctx.fillRect(x, y, 2, 2);
    } else {
      ctx.fillStyle = '#5f9636';
      ctx.fillRect(x, y, 2, 1);
    }
  }

  // ── roads (side paths first so main roads paint over them) ──
  for (const r of roads.side) paintRoad(ctx, r, WORLD_SEED);
  for (const r of roads.main.values()) paintRoad(ctx, r, WORLD_SEED);

  // ── places ──
  const ordered = [...places].sort((a, b) => a.rect.y - b.rect.y);
  for (const g of ordered) drawPlaceStatic(ctx, g);

  // ── decorations in the free space ──
  const blocked = (x: number, y: number, margin: number): boolean => {
    if (x < margin || y < margin || x > WORLD_W - margin || y > WORLD_H - margin) return true;
    for (const g of places) {
      const r = g.rect;
      if (x > r.x - margin && x < r.x + r.w + margin && y > r.y - margin && y < r.y + r.h + margin) return true;
    }
    return nearRoad(roads, x, y, margin);
  };
  const deco = mulberry32(WORLD_SEED ^ 0x51f15eed);

  // tree clusters
  let clusters = 0;
  for (let i = 0; i < 400 && clusters < 26; i++) {
    const x = 24 + Math.floor(deco() * (WORLD_W - 48));
    const y = 44 + Math.floor(deco() * (WORLD_H - 70));
    const count = 2 + (deco() < 0.45 ? 1 : 0);
    const spots: Array<{ x: number; y: number; r: number }> = [];
    let ok = true;
    for (let n = 0; n < count; n++) {
      const sx = x + Math.floor((deco() - 0.5) * 46);
      const sy = y + Math.floor((deco() - 0.5) * 28);
      const r = 8 + Math.floor(deco() * 5);
      if (blocked(sx, sy, r + 8) || blocked(sx - r, sy - r - 8, 4) || blocked(sx + r, sy - r - 8, 4)) {
        ok = false;
        break;
      }
      spots.push({ x: sx, y: sy, r });
    }
    if (!ok || spots.length === 0) continue;
    clusters++;
    spots.sort((u, v) => u.y - v.y);
    for (const s of spots) drawTree(ctx, s.x, s.y, s.r, deco);
  }

  // fences
  let fences = 0;
  for (let i = 0; i < 120 && fences < 9; i++) {
    const x = 16 + Math.floor(deco() * (WORLD_W - 120));
    const y = 24 + Math.floor(deco() * (WORLD_H - 56));
    const posts = 4 + Math.floor(deco() * 4);
    const len = (posts - 1) * 12;
    let clear = true;
    for (let px = x; px <= x + len; px += 6) {
      if (blocked(px, y, 8)) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    fences++;
    ctx.fillStyle = '#a9743f';
    ctx.fillRect(x, y - 5, len, 2);
    ctx.fillRect(x, y - 1, len, 2);
    for (let p = 0; p < posts; p++) {
      ctx.fillStyle = '#8a5a33';
      ctx.fillRect(x + p * 12 - 1, y - 8, 3, 10);
      ctx.fillStyle = '#6b4226';
      ctx.fillRect(x + p * 12 - 1, y + 1, 3, 1);
    }
  }

  // bushes
  let bushes = 0;
  for (let i = 0; i < 160 && bushes < 30; i++) {
    const x = 12 + Math.floor(deco() * (WORLD_W - 24));
    const y = 16 + Math.floor(deco() * (WORLD_H - 28));
    if (blocked(x, y, 8)) continue;
    bushes++;
    drawPixelDisc(ctx, x, y, 5, '#4f7d35');
    drawPixelDisc(ctx, x - 1, y - 2, 3, '#639a40');
    ctx.fillStyle = '#7ab84d';
    ctx.fillRect(x - 1, y - 3, 2, 1);
  }

  // flowers
  const flowerColors = ['#f2f2f2', '#f2c14e', '#e2737f', '#e8a2c8'];
  for (let i = 0; i < 180; i++) {
    const x = 8 + Math.floor(deco() * (WORLD_W - 16));
    const y = 8 + Math.floor(deco() * (WORLD_H - 16));
    if (blocked(x, y, 4)) continue;
    ctx.fillStyle = '#4f7d35';
    ctx.fillRect(x, y, 1, 2);
    ctx.fillStyle = flowerColors[Math.floor(deco() * flowerColors.length)] ?? '#f2f2f2';
    ctx.fillRect(x - 1, y - 2, 2, 2);
  }

  // one pond in a clear pocket
  for (let i = 0; i < 200; i++) {
    const x = 80 + Math.floor(deco() * (WORLD_W - 160));
    const y = 80 + Math.floor(deco() * (WORLD_H - 160));
    const rx = 30;
    const ry = 17;
    if (blocked(x, y, rx + 10) || blocked(x - rx, y, 8) || blocked(x + rx, y, 8) || blocked(x, y - ry, 8) || blocked(x, y + ry, 8)) continue;
    drawPixelEllipse(ctx, x, y + 3, rx + 2, ry + 1, 'rgba(40,52,28,0.22)');
    drawPixelEllipse(ctx, x, y, rx, ry, '#6fae6b');
    drawPixelEllipse(ctx, x, y, rx - 3, ry - 2, '#3f6f9e');
    drawPixelEllipse(ctx, x, y, rx - 7, ry - 4, '#508bc0');
    ctx.fillStyle = '#85b8dd';
    for (let k = 0; k < 5; k++) {
      const rr = 4 + k * 3;
      ctx.fillRect(x - rr - 2, y - 3 + k, 4, 1);
      ctx.fillRect(x + rr - 1, y + 2 - k, 3, 1);
    }
    for (let k = 0; k < 8; k++) {
      const a = deco() * Math.PI * 2;
      const px = Math.round(x + Math.cos(a) * (rx - 1));
      const py = Math.round(y + Math.sin(a) * (ry - 1));
      ctx.fillStyle = '#5f9636';
      ctx.fillRect(px, py - 3, 1, 4);
      ctx.fillRect(px + 1, py - 2, 1, 3);
    }
    world.pond = { x, y, rx, ry };
    break;
  }

  // mossy rocks
  let rocks = 0;
  for (let i = 0; i < 200 && rocks < 22; i++) {
    const x = 16 + Math.floor(deco() * (WORLD_W - 32));
    const y = 16 + Math.floor(deco() * (WORLD_H - 32));
    if (blocked(x, y, 9)) continue;
    rocks++;
    const w = 6 + Math.floor(deco() * 5);
    const h = 4 + Math.floor(deco() * 3);
    drawPixelEllipse(ctx, x, y + h - 1, w, 2, 'rgba(30,30,30,0.22)');
    ctx.fillStyle = '#7c8088';
    ctx.fillRect(x - w, y - h, w * 2, h * 2);
    ctx.fillStyle = '#9aa0a8';
    ctx.fillRect(x - w, y - h, w * 2, 2);
    ctx.fillStyle = '#5f636b';
    ctx.fillRect(x - w, y + h - 2, w * 2, 2);
    ctx.fillStyle = '#6e9a3e';
    ctx.fillRect(x - w + 1, y - h, 2, 1);
  }

  // toadstools
  let shrooms = 0;
  for (let i = 0; i < 200 && shrooms < 18; i++) {
    const x = 16 + Math.floor(deco() * (WORLD_W - 32));
    const y = 16 + Math.floor(deco() * (WORLD_H - 32));
    if (blocked(x, y, 7)) continue;
    shrooms++;
    const n = 1 + Math.floor(deco() * 3);
    for (let m = 0; m < n; m++) {
      const mx = x + Math.floor((deco() - 0.5) * 10);
      const my = y + Math.floor((deco() - 0.5) * 6);
      ctx.fillStyle = '#ece4d4';
      ctx.fillRect(mx, my, 2, 3);
      ctx.fillStyle = '#c5403a';
      ctx.fillRect(mx - 1, my - 2, 4, 2);
      ctx.fillStyle = '#f3ede0';
      ctx.fillRect(mx, my - 2, 1, 1);
    }
  }

  // crop plots
  let plots = 0;
  for (let i = 0; i < 160 && plots < 5; i++) {
    const cols = 4 + Math.floor(deco() * 3);
    const rowsN = 3 + Math.floor(deco() * 2);
    const pw = cols * 8;
    const ph = rowsN * 7;
    const x = 24 + Math.floor(deco() * (WORLD_W - 48 - pw));
    const y = 24 + Math.floor(deco() * (WORLD_H - 48 - ph));
    let clear = true;
    for (let cy = 0; cy <= ph && clear; cy += 7) {
      for (let cx = 0; cx <= pw; cx += 8) {
        if (blocked(x + cx, y + cy, 6)) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;
    plots++;
    drawPixelEllipse(ctx, x + pw / 2, y + ph + 1, pw / 2 + 2, 3, 'rgba(40,40,20,0.18)');
    ctx.fillStyle = '#8a6a3f';
    ctx.fillRect(x - 2, y - 2, pw + 4, ph + 4);
    for (let ry2 = 0; ry2 < rowsN; ry2++) {
      const rowY = y + ry2 * 7;
      ctx.fillStyle = '#6e4f2e';
      ctx.fillRect(x, rowY, pw, 5);
      ctx.fillStyle = '#5a3f24';
      ctx.fillRect(x, rowY + 4, pw, 1);
      for (let cx = 0; cx < cols; cx++) {
        const sx = x + cx * 8 + 3;
        ctx.fillStyle = deco() < 0.5 ? '#74a83f' : '#8cc14c';
        ctx.fillRect(sx, rowY + 1, 2, 3);
        ctx.fillRect(sx - 1, rowY + 1, 1, 1);
        ctx.fillRect(sx + 2, rowY + 1, 1, 1);
      }
    }
  }

  // grass tufts that sway per frame (positions only; drawn live)
  for (let i = 0; i < 90; i++) {
    const x = 10 + Math.floor(deco() * (WORLD_W - 20));
    const y = 10 + Math.floor(deco() * (WORLD_H - 20));
    if (blocked(x, y, 5)) continue;
    world.tufts.push({ x, y });
  }

  return world;
}

/** Tile-aligned rect of a place footprint, for editor outlines / drag clamping. */
export function footprintRect(kind: PlaceDef['kind'], id: string, tile: TilePos): Rect {
  const fp = footprintFor(kind, id);
  return { x: tile.tx * TILE, y: tile.ty * TILE, w: fp.tw * TILE, h: fp.th * TILE };
}
