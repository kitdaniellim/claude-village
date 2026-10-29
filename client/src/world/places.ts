// Place geometry (footprints, gates, building doors) and the static art for
// each place kind. Geometry is cheap and recomputed on layout change; the art is
// painted once into the terrain layer by terrain.ts.

import type { PlaceDef, PlaceKind, WildLandmark } from './registry';
import { hashString } from './registry';
import { BUILDING_DEFS } from '../utils/buildingSprites';
import { TILE, footprintFor } from './constants';
import type { TilePos } from './constants';
import { drawPixelDisc, drawPixelEllipse, matrixRects, mulberry32, renderMatrix } from './pixel';
import type { Pt, Rect } from './pixel';
import { STONE_TEMPLATES, TIMBER_TEMPLATES, renderTemplate } from './sprites';
import type { RenderedTemplate } from './sprites';

export type Landmark = WildLandmark;
const LANDMARKS: Landmark[] = ['ruins', 'stones', 'grove', 'camp', 'windmill', 'shrine', 'tower', 'cottage'];

/** Tavern inn: the 32x18 matrix at scale 4; plaza ellipse x-radius (y is 0.82 of it). */
export const TAVERN_SCALE = 4;
export const TAVERN_W = 32 * TAVERN_SCALE;
export const TAVERN_H = 18 * TAVERN_SCALE;
export const PLAZA_R = 100;
export const PLAZA_SQUASH = 0.82;

export interface BuildingGeom {
  placeId: string;
  repoId: string;
  name: string;
  rect: Rect;
  door: Pt;
  /** window rects (world px) that glow at night */
  glow: Rect[];
  chimney: Pt | null;
  /** Pre-rendered sprite (day) and its lit-windows variant, if the building is a sprite. */
  day: { img: HTMLCanvasElement; x: number; y: number } | null;
  lit: { img: HTMLCanvasElement; x: number; y: number } | null;
}

export interface PlaceGeom {
  id: string;
  name: string;
  kind: PlaceKind;
  def: PlaceDef;
  tile: TilePos;
  rect: Rect;
  /** Road endpoint. */
  gate: Pt;
  /** Waypoint just outside the gate so roads arrive from the open side. */
  approach: Pt;
  /** Where heroes stand when they belong to the place but no specific repo. */
  square: Pt;
  /** Name banner anchor (top-centre). */
  bannerAt: Pt;
  buildings: BuildingGeom[];
  torches: Pt[];
  flags: Pt[];
  chimneys: Pt[];
  windmill: Pt | null;
  /** Lair only: where the dragon sits (sprite top-left) and the fight spot. */
  dragon: { x: number; y: number } | null;
  bats: Pt | null;
  campfire: Pt | null;
  landmark: Landmark | null;
  /** Tavern only: plaza centre + radius (roads start on its rim). */
  plaza: { c: Pt; r: number } | null;
}

export function landmarkFor(def: PlaceDef): Landmark {
  if (def.landmark) return def.landmark;
  if (def.id === 'portfolio') return 'tower';
  if (def.id === 'rts-agents') return 'cottage';
  return LANDMARKS[hashString(def.id) % LANDMARKS.length] ?? 'ruins';
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export function computePlaceGeom(def: PlaceDef, tile: TilePos): PlaceGeom {
  const fp = footprintFor(def.kind, def.id);
  const rect: Rect = { x: tile.tx * TILE, y: tile.ty * TILE, w: fp.tw * TILE, h: fp.th * TILE };
  const cx = rect.x + rect.w / 2;
  const base: PlaceGeom = {
    id: def.id,
    name: def.name,
    kind: def.kind,
    def,
    tile,
    rect,
    gate: { x: cx, y: rect.y + rect.h - 6 },
    approach: { x: cx, y: rect.y + rect.h + 22 },
    square: { x: cx, y: rect.y + rect.h - 30 },
    bannerAt: { x: cx, y: rect.y + 2 },
    buildings: [],
    torches: [],
    flags: [],
    chimneys: [],
    windmill: null,
    dragon: null,
    bats: null,
    campfire: null,
    landmark: null,
    plaza: null,
  };

  switch (def.kind) {
    case 'tavern': {
      // scale-4 inn (128x72) on the top of a 200 px plaza; heroes rest on the lower half
      const plazaC = { x: cx, y: rect.y + 102 };
      const bx = Math.round(cx - TAVERN_W / 2);
      const by = rect.y + 12;
      base.plaza = { c: plazaC, r: PLAZA_R };
      base.gate = { x: cx, y: by + TAVERN_H };
      base.approach = { x: cx, y: by + TAVERN_H + 18 };
      base.square = { x: cx, y: plazaC.y + 24 };
      base.bannerAt = { x: cx, y: rect.y - 14 };
      base.chimneys = [{ x: bx + 26, y: by + 2 }];
      base.torches = [
        { x: bx - 10, y: by + 54 },
        { x: bx + TAVERN_W + 10, y: by + 54 },
      ];
      const tav = BUILDING_DEFS.tavern;
      base.buildings = [
        {
          placeId: def.id,
          repoId: 'tavern',
          name: 'The Tavern',
          rect: { x: bx, y: by, w: TAVERN_W, h: TAVERN_H },
          door: { x: bx + 62, y: by + TAVERN_H + 4 },
          glow: matrixRects(tav.rows, tav.glowChars, TAVERN_SCALE).map((r) => ({ ...r, x: r.x + bx, y: r.y + by })),
          chimney: { x: bx + 26, y: by + 2 },
          day: null,
          lit: { img: renderMatrix(tav.rows, { ...tav.palette, ...tav.lit }, TAVERN_SCALE), x: bx, y: by },
        },
      ];
      break;
    }
    case 'city': {
      const timber = def.id === 'habits';
      const templates = timber ? TIMBER_TEMPLATES : STONE_TEMPLATES;
      const wall = timber ? 8 : 12;
      const n = def.repos.length;
      const rows = n <= 3 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
      const innerX = rect.x + wall + 4;
      const innerW = rect.w - 2 * (wall + 4);
      const bh = timber ? 44 : 40;
      const rowGap = 34;
      const top = rect.y + 28;
      let i = 0;
      rows.forEach((count, r) => {
        const rowY = top + r * (bh + rowGap);
        const slot = innerW / Math.max(1, count);
        for (let c = 0; c < count; c++) {
          const repo = def.repos[i];
          if (!repo) break;
          const tpl = renderTemplate(templates[(hashString(repo.id) + c) % templates.length] as (typeof templates)[number]);
          const bx = Math.round(innerX + slot * c + slot / 2 - tpl.w / 2);
          const by = rowY + (bh - tpl.h);
          base.buildings.push(buildingGeom(def.id, repo.id, repo.name, tpl, bx, by));
          i++;
        }
      });
      base.gate = { x: cx, y: rect.y + rect.h - wall / 2 };
      base.approach = { x: cx, y: rect.y + rect.h + 24 };
      base.square = { x: cx, y: rect.y + rect.h - wall - 22 };
      base.bannerAt = { x: cx, y: rect.y - 4 };
      base.torches = [
        { x: cx - 16, y: rect.y + rect.h - wall - 4 },
        { x: cx + 16, y: rect.y + rect.h - wall - 4 },
      ];
      base.flags = [
        { x: rect.x + 8, y: rect.y + 2 },
        { x: rect.x + rect.w - 8, y: rect.y + 2 },
        { x: rect.x + 8, y: rect.y + rect.h - 26 },
        { x: rect.x + rect.w - 8, y: rect.y + rect.h - 26 },
      ];
      base.chimneys = base.buildings.flatMap((b) => (b.chimney ? [b.chimney] : []));
      break;
    }
    case 'dungeon': {
      const faceY = rect.y + 128;
      base.gate = { x: cx, y: faceY + 26 };
      base.approach = { x: cx, y: faceY + 56 };
      base.square = { x: cx, y: faceY + 22 };
      base.bannerAt = { x: cx, y: rect.y + 8 };
      base.torches = [
        { x: cx - 24, y: faceY - 14 },
        { x: cx + 24, y: faceY - 14 },
      ];
      base.bats = { x: cx, y: rect.y + 70 };
      const offsets = [-108, -58, 58, 108];
      def.repos.forEach((repo, i) => {
        const ox = offsets[i % offsets.length] ?? 0;
        const dx = Math.round(cx + ox);
        const r: Rect = { x: dx - 10, y: faceY - 22, w: 20, h: 24 };
        base.buildings.push({
          placeId: def.id,
          repoId: repo.id,
          name: repo.name,
          rect: r,
          // heroes stand on the scorched ground below the name plate
          door: { x: dx, y: faceY + 32 },
          glow: [{ x: dx - 3, y: faceY - 12, w: 6, h: 6 }],
          chimney: null,
          day: null,
          lit: null,
        });
      });
      break;
    }
    case 'lair': {
      const baseY = rect.y + 168;
      base.gate = { x: cx, y: baseY + 18 };
      base.approach = { x: cx, y: baseY + 48 };
      base.square = { x: cx - 20, y: baseY + 14 };
      base.bannerAt = { x: cx, y: rect.y + 6 };
      base.dragon = { x: Math.round(cx - 40), y: rect.y + 66 };
      const offsets = [-96, -40];
      def.repos.forEach((repo, i) => {
        const ox = offsets[i % offsets.length] ?? 0;
        const dx = Math.round(cx + ox);
        const r: Rect = { x: dx - 12, y: baseY - 26, w: 24, h: 26 };
        base.buildings.push({
          placeId: def.id,
          repoId: repo.id,
          name: repo.name,
          rect: r,
          door: { x: dx, y: baseY + 32 },
          glow: [{ x: dx - 4, y: baseY - 14, w: 8, h: 8 }],
          chimney: null,
          day: null,
          lit: null,
        });
      });
      base.torches = [{ x: cx - 68, y: baseY - 8 }];
      break;
    }
    default: {
      const lm = landmarkFor(def);
      base.landmark = lm;
      const cy = rect.y + 52;
      base.gate = { x: cx, y: rect.y + rect.h - 4 };
      base.approach = { x: cx, y: rect.y + rect.h + 26 };
      base.square = { x: cx + 18, y: cy + 22 };
      base.bannerAt = { x: cx, y: rect.y - 2 };
      const repo = def.repos[0];
      base.buildings = [
        {
          placeId: def.id,
          repoId: repo?.id ?? def.id,
          name: repo?.name ?? def.name,
          rect: { x: cx - 30, y: rect.y + 4, w: 60, h: 72 },
          door: { x: cx - 4, y: cy + 48 },
          glow: lm === 'tower' ? [{ x: cx - 3, y: cy - 36, w: 6, h: 6 }, { x: cx - 3, y: cy - 16, w: 6, h: 6 }] : lm === 'cottage' ? [{ x: cx - 14, y: cy - 2, w: 6, h: 6 }, { x: cx + 8, y: cy - 2, w: 6, h: 6 }] : [],
          chimney: lm === 'cottage' ? { x: cx + 14, y: cy - 30 } : null,
          day: null,
          lit: null,
        },
      ];
      if (lm === 'cottage') base.chimneys = [{ x: cx + 14, y: cy - 30 }];
      if (lm === 'windmill') base.windmill = { x: cx, y: cy - 28 };
      if (lm === 'camp') base.campfire = { x: cx + 14, y: cy + 10 };
      if (lm === 'shrine') base.torches = [{ x: cx - 12, y: cy - 2 }, { x: cx + 12, y: cy - 2 }];
      if (lm === 'tower') base.flags = [{ x: cx, y: cy - 62 }];
      break;
    }
  }
  return base;
}

function buildingGeom(placeId: string, repoId: string, name: string, tpl: RenderedTemplate, bx: number, by: number): BuildingGeom {
  const t = tpl.template;
  return {
    placeId,
    repoId,
    name,
    rect: { x: bx, y: by, w: tpl.w, h: tpl.h },
    // heroes stand in the lane below the name plate (plates are ~13 world px tall at the fit zoom)
    door: { x: bx + t.doorDx, y: by + tpl.h + 30 },
    glow: matrixRects(t.rows, t.glowChars, 2).map((r) => ({ ...r, x: r.x + bx, y: r.y + by })),
    chimney: t.chimney ? { x: bx + t.chimney.x, y: by + t.chimney.y } : null,
    day: { img: tpl.day, x: bx, y: by },
    lit: { img: tpl.lit, x: bx, y: by },
  };
}

// ── Static art ───────────────────────────────────────────────────────────────

export function drawPlaceStatic(ctx: CanvasRenderingContext2D, g: PlaceGeom): void {
  const rng = mulberry32(hashString(g.id) ^ 0x7a1ace);
  switch (g.kind) {
    case 'tavern':
      drawTavernPlaza(ctx, g, rng);
      break;
    case 'city':
      if (g.id === 'habits') drawTimberTown(ctx, g, rng);
      else drawStoneCity(ctx, g, rng);
      break;
    case 'dungeon':
      drawDungeon(ctx, g, rng);
      break;
    case 'lair':
      drawLair(ctx, g, rng);
      break;
    default:
      drawWild(ctx, g, rng);
  }
}

function cobbles(ctx: CanvasRenderingContext2D, rng: () => number, cx: number, cy: number, r: number, n: number, squash = 1): void {
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * (r - 4);
    const x = Math.round(cx + Math.cos(a) * rr);
    const y = Math.round(cy + Math.sin(a) * rr * squash);
    const w = 4 + Math.floor(rng() * 3);
    const h = 3 + Math.floor(rng() * 2);
    const tone = rng();
    ctx.fillStyle = tone < 0.33 ? '#c8b899' : tone < 0.66 ? '#b3a284' : '#a8997e';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#93846a';
    ctx.fillRect(x, y + h - 1, w, 1);
    if (rng() < 0.5) {
      ctx.fillStyle = '#d6c7a8';
      ctx.fillRect(x + 1, y, w - 2, 1);
    }
  }
}

function drawLanternPost(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#3a2d1f';
  ctx.fillRect(x - 1, y - 18, 3, 20);
  ctx.fillRect(x - 3, y, 7, 2);
  ctx.fillStyle = '#5d4524';
  ctx.fillRect(x - 3, y - 22, 7, 5);
  ctx.fillStyle = '#ffd97a';
  ctx.fillRect(x - 2, y - 21, 5, 3);
}

function drawBarrel(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = '#7a4f2a';
  ctx.fillRect(x, y, 8, 10);
  ctx.fillStyle = '#9a6a3a';
  ctx.fillRect(x + 1, y, 2, 10);
  ctx.fillStyle = '#4a4a52';
  ctx.fillRect(x, y + 2, 8, 1);
  ctx.fillRect(x, y + 7, 8, 1);
}

function drawTable(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawPixelEllipse(ctx, x + 9, y + 9, 10, 3, 'rgba(40,30,15,0.25)');
  ctx.fillStyle = '#8a5a33';
  ctx.fillRect(x, y, 18, 5);
  ctx.fillStyle = '#a9743f';
  ctx.fillRect(x, y, 18, 1);
  ctx.fillStyle = '#5d3d22';
  ctx.fillRect(x + 2, y + 5, 2, 4);
  ctx.fillRect(x + 14, y + 5, 2, 4);
  // mugs
  ctx.fillStyle = '#c98a3a';
  ctx.fillRect(x + 4, y - 3, 3, 3);
  ctx.fillRect(x + 11, y - 3, 3, 3);
  ctx.fillStyle = '#f4ead2';
  ctx.fillRect(x + 4, y - 4, 3, 1);
  ctx.fillRect(x + 11, y - 4, 3, 1);
}

function drawTavernPlaza(ctx: CanvasRenderingContext2D, g: PlaceGeom, rng: () => number): void {
  const plaza = g.plaza;
  if (!plaza) return;
  const { c, r } = plaza;
  const sq = PLAZA_SQUASH;
  drawPixelEllipse(ctx, c.x, c.y, r + 4, Math.round((r + 4) * sq), '#9c8d72');
  drawPixelEllipse(ctx, c.x, c.y, r, Math.round(r * sq), '#bcab8d');
  cobbles(ctx, rng, c.x, c.y, r, 1250, sq);
  // dithered rim
  for (let i = 0; i < 340; i++) {
    const a = (i / 340) * Math.PI * 2;
    ctx.fillStyle = i % 3 === 0 ? '#9c8d72' : '#ab9b7e';
    ctx.fillRect(Math.round(c.x + Math.cos(a) * (r - 1)), Math.round(c.y + Math.sin(a) * (r - 1) * sq), 2, 2);
  }
  // the tavern (scale 4 — the heart of the village)
  const b = g.buildings[0];
  if (b) {
    const tav = BUILDING_DEFS.tavern;
    drawPixelEllipse(ctx, b.rect.x + TAVERN_W / 2, b.rect.y + TAVERN_H, TAVERN_W / 2 + 6, 7, 'rgba(40,30,15,0.28)');
    ctx.drawImage(renderMatrix(tav.rows, tav.palette, TAVERN_SCALE), b.rect.x, b.rect.y);
    // hanging mug sign
    const sx = b.rect.x + TAVERN_W;
    const sy = b.rect.y + 40;
    ctx.fillStyle = '#3a2d1f';
    ctx.fillRect(sx, sy, 13, 2);
    ctx.fillStyle = '#c98a3a';
    ctx.fillRect(sx + 6, sy + 2, 8, 8);
    ctx.fillStyle = '#f4ead2';
    ctx.fillRect(sx + 6, sy + 2, 8, 3);
  }
  // tables, barrels, lantern posts and a well, all kept off the rest grid (world/plaza.ts)
  drawTable(ctx, c.x - 94, c.y - 34);
  drawTable(ctx, c.x + 76, c.y - 30);
  drawBarrel(ctx, c.x + 66, c.y - 52);
  drawBarrel(ctx, c.x + 75, c.y - 48);
  drawBarrel(ctx, c.x - 92, c.y + 20);
  drawBarrel(ctx, c.x - 82, c.y + 26);
  drawLanternPost(ctx, c.x - 72, c.y + 52);
  drawLanternPost(ctx, c.x + 72, c.y + 52);
  // well
  const wx = c.x + 84;
  const wy = c.y + 28;
  drawPixelEllipse(ctx, wx, wy + 6, 9, 3, 'rgba(40,30,15,0.25)');
  drawPixelEllipse(ctx, wx, wy, 8, 5, '#6e7682');
  drawPixelEllipse(ctx, wx, wy - 1, 6, 3, '#3f6f9e');
  ctx.fillStyle = '#85b8dd';
  ctx.fillRect(wx - 3, wy - 2, 3, 1);
  ctx.fillStyle = '#7a5230';
  ctx.fillRect(wx - 8, wy - 12, 2, 12);
  ctx.fillRect(wx + 6, wy - 12, 2, 12);
  ctx.fillStyle = '#7e2f28';
  ctx.fillRect(wx - 10, wy - 15, 20, 3);
}

// ── Stone city (SIF) ─────────────────────────────────────────────────────────

function stoneBlock(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rng: () => number): void {
  ctx.fillStyle = '#8d95a3';
  ctx.fillRect(x, y, w, h);
  for (let yy = 0; yy < h; yy += 4) {
    ctx.fillStyle = '#6f7785';
    ctx.fillRect(x, y + yy + 3, w, 1);
    const off = (Math.floor(yy / 4) % 2) * 4;
    for (let xx = off; xx < w; xx += 8) ctx.fillRect(x + xx, y + yy, 1, 3);
    if (rng() < 0.5) {
      ctx.fillStyle = '#a3abb8';
      ctx.fillRect(x + Math.floor(rng() * Math.max(1, w - 4)), y + yy + 1, 3, 1);
    }
  }
}

function drawStoneCity(ctx: CanvasRenderingContext2D, g: PlaceGeom, rng: () => number): void {
  const { x, y, w, h } = g.rect;
  const wall = 12;
  // packed-earth interior with a cobbled main street
  ctx.fillStyle = '#c9b48c';
  ctx.fillRect(x + 4, y + 16, w - 8, h - 20);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = rng() < 0.5 ? '#bfa981' : '#d2bf98';
    ctx.fillRect(x + 6 + Math.floor(rng() * (w - 12)), y + 18 + Math.floor(rng() * (h - 24)), 2, 2);
  }
  const streetX = g.gate.x;
  ctx.fillStyle = '#b3a284';
  ctx.fillRect(streetX - 14, y + 40, 28, h - 44);
  cobbles(ctx, rng, streetX, y + h / 2 + 10, 14, 90, (h - 44) / 28);
  // lanes between building rows
  ctx.fillStyle = '#b8a688';
  ctx.fillRect(x + wall + 2, y + 28 + 40 + 2, w - 2 * wall - 4, 14);
  ctx.fillRect(x + wall + 2, y + h - wall - 30, w - 2 * wall - 4, 14);
  // walls: top face + front face with crenellations
  const wallFace = (wx: number, wy: number, ww: number, wh: number): void => {
    stoneBlock(ctx, wx, wy, ww, wh, rng);
    ctx.fillStyle = '#b4bbc6';
    ctx.fillRect(wx, wy, ww, 2);
    ctx.fillStyle = '#4e5563';
    ctx.fillRect(wx, wy + wh - 2, ww, 2);
  };
  wallFace(x + 4, y + 12, w - 8, wall);
  wallFace(x + 4, y + h - wall - 4, w - 8, wall + 4);
  wallFace(x + 4, y + 12, 8, h - 16);
  wallFace(x + w - 12, y + 12, 8, h - 16);
  // crenellations along top + bottom walls
  ctx.fillStyle = '#9aa1ad';
  for (let cx = x + 6; cx < x + w - 8; cx += 8) {
    ctx.fillRect(cx, y + 8, 4, 4);
    ctx.fillRect(cx, y + h - wall - 8, 4, 4);
  }
  // corner towers
  const tower = (tx: number, ty: number): void => {
    stoneBlock(ctx, tx - 8, ty, 16, 30, rng);
    ctx.fillStyle = '#4e5563';
    ctx.fillRect(tx - 8, ty + 28, 16, 2);
    ctx.fillStyle = '#9aa1ad';
    for (let k = -8; k < 8; k += 5) ctx.fillRect(tx + k, ty - 4, 3, 4);
    ctx.fillStyle = '#2f3540';
    ctx.fillRect(tx - 2, ty + 10, 4, 5);
  };
  tower(x + 8, y + 2);
  tower(x + w - 8, y + 2);
  tower(x + 8, y + h - 28);
  tower(x + w - 8, y + h - 28);
  // gate: arched opening with portcullis
  const gx = g.gate.x;
  const gy = y + h - wall - 4;
  ctx.fillStyle = '#2a2420';
  ctx.fillRect(gx - 11, gy, 22, wall + 4);
  drawPixelDisc(ctx, gx, gy + 1, 10, '#2a2420');
  ctx.fillStyle = '#5a4a3a';
  for (let k = -8; k <= 8; k += 4) ctx.fillRect(gx + k, gy - 2, 1, 10);
  ctx.fillRect(gx - 9, gy + 2, 18, 1);
  ctx.fillStyle = '#c1c7d1';
  drawPixelDisc(ctx, gx, gy, 12, '#7d848f');
  drawPixelDisc(ctx, gx, gy + 1, 10, '#2a2420');
  ctx.fillStyle = '#5a4a3a';
  for (let k = -8; k <= 8; k += 4) ctx.fillRect(gx + k, gy - 4, 1, 12);
  // buildings
  for (const b of g.buildings) {
    drawPixelEllipse(ctx, b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h, b.rect.w / 2 + 2, 4, 'rgba(40,30,15,0.28)');
    if (b.day) ctx.drawImage(b.day.img, b.day.x, b.day.y);
  }
  // crates and a cart near the gate
  drawBarrel(ctx, gx - 30, y + h - wall - 22);
  drawBarrel(ctx, gx - 40, y + h - wall - 20);
  ctx.fillStyle = '#8a5a33';
  ctx.fillRect(gx + 24, y + h - wall - 26, 16, 7);
  ctx.fillStyle = '#4a4a52';
  drawPixelDisc(ctx, gx + 27, y + h - wall - 17, 3, '#4a4a52');
  drawPixelDisc(ctx, gx + 37, y + h - wall - 17, 3, '#4a4a52');
}

// ── Timber market town (HABITS) ──────────────────────────────────────────────

function drawTimberTown(ctx: CanvasRenderingContext2D, g: PlaceGeom, rng: () => number): void {
  const { x, y, w, h } = g.rect;
  // trodden earth with grass patches
  ctx.fillStyle = '#c4a978';
  ctx.fillRect(x + 4, y + 14, w - 8, h - 18);
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = rng() < 0.5 ? '#b8995f' : '#d0b88a';
    ctx.fillRect(x + 6 + Math.floor(rng() * (w - 12)), y + 16 + Math.floor(rng() * (h - 22)), 2, 2);
  }
  // palisade (pointed logs)
  const logs = (lx: number, ly: number, len: number, vertical: boolean): void => {
    for (let k = 0; k < len; k += 4) {
      const tone = k % 8 === 0 ? '#8a5a33' : '#a9743f';
      ctx.fillStyle = tone;
      if (vertical) {
        ctx.fillRect(lx, ly + k, 6, 4);
      } else {
        ctx.fillRect(lx + k, ly, 4, 10);
        ctx.fillStyle = '#c99d5e';
        ctx.fillRect(lx + k + 1, ly - 2, 2, 2);
        ctx.fillStyle = '#5d3d22';
        ctx.fillRect(lx + k, ly + 9, 4, 1);
      }
    }
  };
  logs(x + 4, y + 10, w - 8, false);
  logs(x + 4, y + h - 12, w - 8, false);
  logs(x + 4, y + 10, h - 14, true);
  logs(x + w - 10, y + 10, h - 14, true);
  // corner posts with lanterns
  for (const [px, py] of [
    [x + 7, y + 8],
    [x + w - 7, y + 8],
    [x + 7, y + h - 10],
    [x + w - 7, y + h - 10],
  ] as const) {
    ctx.fillStyle = '#5d3d22';
    ctx.fillRect(px - 3, py - 8, 6, 16);
    ctx.fillStyle = '#ffd97a';
    ctx.fillRect(px - 1, py - 6, 2, 3);
  }
  // open timber gate
  const gx = g.gate.x;
  const gy = y + h - 12;
  ctx.fillStyle = '#c4a978';
  ctx.fillRect(gx - 12, gy - 2, 24, 14);
  ctx.fillStyle = '#5d3d22';
  ctx.fillRect(gx - 16, gy - 14, 4, 26);
  ctx.fillRect(gx + 12, gy - 14, 4, 26);
  ctx.fillRect(gx - 16, gy - 16, 32, 3);
  ctx.fillStyle = '#8a5a33';
  ctx.fillRect(gx - 12, gy - 6, 5, 14);
  ctx.fillRect(gx + 7, gy - 6, 5, 14);
  // market stalls between the buildings
  const stall = (sx: number, sy: number, c1: string, c2: string): void => {
    drawPixelEllipse(ctx, sx + 11, sy + 12, 13, 3, 'rgba(40,30,15,0.22)');
    ctx.fillStyle = '#5d3d22';
    ctx.fillRect(sx, sy, 2, 12);
    ctx.fillRect(sx + 20, sy, 2, 12);
    for (let k = 0; k < 22; k += 4) {
      ctx.fillStyle = k % 8 === 0 ? c1 : c2;
      ctx.fillRect(sx + k, sy - 4, 4, 5);
    }
    ctx.fillStyle = '#8a5a33';
    ctx.fillRect(sx, sy + 6, 22, 5);
    ctx.fillStyle = '#e8b04f';
    ctx.fillRect(sx + 3, sy + 4, 4, 2);
    ctx.fillStyle = '#d4493f';
    ctx.fillRect(sx + 10, sy + 4, 4, 2);
    ctx.fillStyle = '#74d77b';
    ctx.fillRect(sx + 16, sy + 4, 4, 2);
  };
  stall(gx - 11, y + h - 46, '#d4493f', '#f1e4c8');
  stall(x + 24, y + h / 2 - 6, '#2e6fb5', '#f1e4c8');
  stall(x + w - 46, y + h / 2 - 6, '#e0a83c', '#f1e4c8');
  // sign post in the centre
  const sx = gx;
  const sy = y + h / 2 + 6;
  ctx.fillStyle = '#5d3d22';
  ctx.fillRect(sx - 1, sy - 20, 3, 22);
  ctx.fillStyle = '#a9743f';
  ctx.fillRect(sx - 9, sy - 18, 18, 5);
  ctx.fillRect(sx - 7, sy - 11, 14, 5);
  // buildings
  for (const b of g.buildings) {
    drawPixelEllipse(ctx, b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h, b.rect.w / 2 + 2, 4, 'rgba(40,30,15,0.28)');
    if (b.day) ctx.drawImage(b.day.img, b.day.x, b.day.y);
  }
  // hay bales
  for (let i = 0; i < 3; i++) {
    const hx = x + 16 + Math.floor(rng() * (w - 40));
    const hy = y + 22 + Math.floor(rng() * 6);
    ctx.fillStyle = '#d6b250';
    ctx.fillRect(hx, hy, 10, 7);
    ctx.fillStyle = '#b38f2e';
    ctx.fillRect(hx, hy + 5, 10, 2);
    ctx.fillStyle = '#f0d078';
    ctx.fillRect(hx + 1, hy, 8, 1);
  }
}

// ── Dungeon (Momma Mia) ──────────────────────────────────────────────────────

function drawDungeon(ctx: CanvasRenderingContext2D, g: PlaceGeom, rng: () => number): void {
  const { x, y, w, h } = g.rect;
  const cx = x + w / 2;
  const faceY = y + 128;
  // bare, scorched ground in front of the hill
  drawPixelEllipse(ctx, cx, faceY + 16, w / 2 - 10, 26, '#8d7f68');
  for (let i = 0; i < 300; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng());
    ctx.fillStyle = rng() < 0.5 ? '#7d7059' : '#9a8c74';
    ctx.fillRect(Math.round(cx + Math.cos(a) * rr * (w / 2 - 12)), Math.round(faceY + 16 + Math.sin(a) * rr * 24), 2, 2);
  }
  // rocky hill: stacked lumps, darker to the right, grass creeping on top
  const lump = (lx: number, ly: number, rx: number, ry: number, base: string, lightC: string, dark: string): void => {
    drawPixelEllipse(ctx, lx, ly, rx, ry, base);
    drawPixelEllipse(ctx, lx - rx * 0.2, ly - ry * 0.25, rx * 0.55, ry * 0.5, lightC);
    for (let i = 0; i < rx * ry * 0.08; i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng());
      ctx.fillStyle = rng() < 0.6 ? dark : lightC;
      ctx.fillRect(Math.round(lx + Math.cos(a) * rr * rx), Math.round(ly + Math.sin(a) * rr * ry), 2, 1);
    }
  };
  lump(cx, faceY - 30, w / 2 - 8, 56, '#6e6358', '#7f7468', '#5a5047');
  lump(cx - 60, faceY - 60, 70, 40, '#786c60', '#8a7e70', '#5f554b');
  lump(cx + 50, faceY - 66, 76, 44, '#6e6358', '#7f7468', '#5a5047');
  lump(cx - 10, faceY - 84, 52, 30, '#857a6c', '#978b7c', '#6a5f54');
  // flat base edge of the hill face
  ctx.fillStyle = '#4e463e';
  ctx.fillRect(x + 14, faceY - 2, w - 28, 3);
  // grass creeping over the top
  for (let i = 0; i < 70; i++) {
    const a = Math.PI + rng() * Math.PI;
    const px = Math.round(cx + Math.cos(a) * (w / 2 - 16));
    const py = Math.round(faceY - 30 + Math.sin(a) * 54);
    ctx.fillStyle = rng() < 0.5 ? '#6da33f' : '#8bc34a';
    ctx.fillRect(px, py, 3, 2);
  }
  // main cave mouth
  ctx.fillStyle = '#3a2f27';
  ctx.fillRect(cx - 20, faceY - 34, 40, 36);
  drawPixelDisc(ctx, cx, faceY - 34, 20, '#3a2f27');
  ctx.fillStyle = '#17120f';
  ctx.fillRect(cx - 16, faceY - 30, 32, 32);
  drawPixelDisc(ctx, cx, faceY - 30, 16, '#17120f');
  // stalactites
  ctx.fillStyle = '#3a2f27';
  for (const k of [-10, -3, 5, 11]) {
    ctx.fillRect(cx + k, faceY - 44, 2, 6 + Math.floor(rng() * 4));
  }
  // faint ember glow deep inside
  ctx.fillStyle = 'rgba(255,120,40,0.18)';
  ctx.fillRect(cx - 8, faceY - 14, 16, 14);
  // chamber doors: iron-banded wood in small arches
  for (const b of g.buildings) {
    const dx = b.rect.x + b.rect.w / 2;
    const dy = b.rect.y;
    ctx.fillStyle = '#3a2f27';
    ctx.fillRect(dx - 10, dy + 4, 20, 20);
    drawPixelDisc(ctx, dx, dy + 4, 10, '#3a2f27');
    ctx.fillStyle = '#17120f';
    ctx.fillRect(dx - 7, dy + 6, 14, 18);
    drawPixelDisc(ctx, dx, dy + 6, 7, '#17120f');
    ctx.fillStyle = '#6e4f2e';
    ctx.fillRect(dx - 6, dy + 8, 12, 16);
    drawPixelDisc(ctx, dx, dy + 8, 6, '#6e4f2e');
    ctx.fillStyle = '#4a4a52';
    ctx.fillRect(dx - 6, dy + 12, 12, 1);
    ctx.fillRect(dx - 6, dy + 19, 12, 1);
    ctx.fillStyle = '#ffd97a';
    ctx.fillRect(dx - 2, dy + 10, 4, 3);
  }
  // torches (sticks; flames animate)
  for (const t of g.torches) {
    ctx.fillStyle = '#5d3d22';
    ctx.fillRect(t.x - 1, t.y, 3, 12);
  }
  // bones, skull, toadstools
  ctx.fillStyle = '#ece4d4';
  ctx.fillRect(cx - 70, faceY + 24, 8, 2);
  ctx.fillRect(cx - 71, faceY + 23, 2, 4);
  ctx.fillRect(cx - 63, faceY + 23, 2, 4);
  ctx.fillRect(cx + 62, faceY + 30, 6, 5);
  ctx.fillStyle = '#17120f';
  ctx.fillRect(cx + 63, faceY + 31, 1, 2);
  ctx.fillRect(cx + 66, faceY + 31, 1, 2);
  for (let i = 0; i < 5; i++) {
    const mx = x + 20 + Math.floor(rng() * (w - 40));
    const my = faceY + 30 + Math.floor(rng() * 20);
    ctx.fillStyle = '#ece4d4';
    ctx.fillRect(mx, my, 2, 3);
    ctx.fillStyle = '#8a4fb5';
    ctx.fillRect(mx - 1, my - 2, 4, 2);
  }
}

// ── Dragon lair (Simone) ─────────────────────────────────────────────────────

function drawLair(ctx: CanvasRenderingContext2D, g: PlaceGeom, rng: () => number): void {
  const { x, y, w, h } = g.rect;
  const cx = x + w / 2;
  const apex = y + 10;
  const baseY = y + 168;
  const halfW = w / 2 - 6;
  // scorched foot of the mountain
  drawPixelEllipse(ctx, cx, baseY + 14, halfW + 4, 26, '#5e5a52');
  for (let i = 0; i < 300; i++) {
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng());
    ctx.fillStyle = rng() < 0.5 ? '#4e4a43' : '#6c675e';
    ctx.fillRect(Math.round(cx + Math.cos(a) * rr * (halfW + 2)), Math.round(baseY + 14 + Math.sin(a) * rr * 24), 2, 2);
  }
  // mountain scanlines: light left face, dark right face, snow cap
  const ridge = (t: number): number => Math.sin(t * 9.3) * 6 + Math.sin(t * 23.1) * 3;
  for (let yy = apex; yy <= baseY; yy++) {
    const t = (yy - apex) / (baseY - apex);
    const hw = Math.max(2, t * halfW + ridge(t));
    const split = Math.round(cx + Math.sin(t * 5) * 8);
    const snow = t < 0.2;
    ctx.fillStyle = snow ? '#eef2f5' : t < 0.45 ? '#7c8089' : '#6b6f78';
    ctx.fillRect(Math.round(cx - hw), yy, Math.max(1, split - Math.round(cx - hw)), 1);
    ctx.fillStyle = snow ? '#c8d2dc' : t < 0.45 ? '#565a63' : '#4b4f58';
    ctx.fillRect(split, yy, Math.max(1, Math.round(cx + hw) - split), 1);
  }
  // crags and ridges
  for (let i = 0; i < 18; i++) {
    const t = 0.3 + rng() * 0.65;
    const yy = Math.round(apex + t * (baseY - apex));
    const hw = t * halfW;
    const px = Math.round(cx + (rng() - 0.5) * hw * 1.6);
    const len = 6 + Math.floor(rng() * 14);
    ctx.fillStyle = rng() < 0.5 ? '#3d414a' : '#8d919a';
    for (let k = 0; k < len; k++) ctx.fillRect(px + k, yy + Math.floor(k * 0.5), 1, 1);
  }
  // the perch: a flat ledge with a scorched rim
  if (g.dragon) {
    const px = g.dragon.x + 36;
    const py = g.dragon.y + 48;
    drawPixelEllipse(ctx, px, py + 2, 62, 10, '#4b4f58');
    drawPixelEllipse(ctx, px, py, 58, 8, '#8d919a');
    drawPixelEllipse(ctx, px, py - 1, 52, 6, '#a4a8b0');
    ctx.fillStyle = '#2a2622';
    for (let k = -40; k < 40; k += 6) ctx.fillRect(px + k, py + 4 + (k % 12 === 0 ? 1 : 0), 4, 1);
  }
  // lava seam
  ctx.fillStyle = '#ff7a2e';
  for (let k = 0; k < 20; k++) ctx.fillRect(Math.round(cx + 40 + k * 2), Math.round(baseY - 70 + k * 3 + Math.sin(k) * 2), 2, 1);
  ctx.fillStyle = '#ffd166';
  for (let k = 0; k < 20; k += 3) ctx.fillRect(Math.round(cx + 40 + k * 2), Math.round(baseY - 70 + k * 3 + Math.sin(k) * 2), 1, 1);
  // cave openings for the repos
  for (const b of g.buildings) {
    const dx = b.rect.x + b.rect.w / 2;
    const dy = b.rect.y;
    ctx.fillStyle = '#3d414a';
    ctx.fillRect(dx - 12, dy + 6, 24, 20);
    drawPixelDisc(ctx, dx, dy + 6, 12, '#3d414a');
    ctx.fillStyle = '#15131a';
    ctx.fillRect(dx - 9, dy + 8, 18, 18);
    drawPixelDisc(ctx, dx, dy + 8, 9, '#15131a');
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(dx - 2, dy + 12, 4, 2);
  }
  // bones + gold glints at the foot
  ctx.fillStyle = '#ece4d4';
  ctx.fillRect(cx + 20, baseY + 20, 10, 2);
  ctx.fillRect(cx + 19, baseY + 19, 2, 4);
  ctx.fillRect(cx + 29, baseY + 19, 2, 4);
  ctx.fillRect(cx - 30, baseY + 26, 6, 5);
  ctx.fillStyle = '#15131a';
  ctx.fillRect(cx - 29, baseY + 27, 1, 2);
  ctx.fillRect(cx - 26, baseY + 27, 1, 2);
  ctx.fillStyle = '#ffd166';
  for (let i = 0; i < 10; i++) ctx.fillRect(cx + 50 + Math.floor(rng() * 40), baseY + 16 + Math.floor(rng() * 16), 2, 1);
  for (const t of g.torches) {
    ctx.fillStyle = '#5d3d22';
    ctx.fillRect(t.x - 1, t.y, 3, 12);
  }
}

// ── Wild landmarks ───────────────────────────────────────────────────────────

function drawTree(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rng: () => number): void {
  drawPixelEllipse(ctx, x, y + 1, r - 1, 3, 'rgba(43,58,22,0.32)');
  ctx.fillStyle = '#9c6b3f';
  ctx.fillRect(x - 2, y - 8, 5, 10);
  ctx.fillStyle = '#b98a55';
  ctx.fillRect(x - 2, y - 8, 1, 9);
  const cy0 = y - r - 6;
  const lobe = Math.max(3, Math.floor(r * 0.62));
  drawPixelDisc(ctx, x - Math.floor(r * 0.6), cy0 + 4, lobe, '#6e8d28');
  drawPixelDisc(ctx, x + Math.floor(r * 0.6), cy0 + 4, lobe, '#6e8d28');
  drawPixelDisc(ctx, x, cy0, r, '#6e8d28');
  drawPixelDisc(ctx, x, cy0 + 1, Math.max(3, r - 2), '#8da832');
  drawPixelDisc(ctx, x - 2, cy0 - 2, Math.max(3, r - 5), '#b3b838');
  for (let s = 0; s < 6; s++) {
    ctx.fillStyle = rng() < 0.5 ? '#d8c94c' : '#c8be40';
    ctx.fillRect(x - r + 1 + Math.floor(rng() * r), cy0 - Math.floor(r * 0.7) + Math.floor(rng() * r), 2, 2);
  }
}

export { drawTree };

function drawWild(ctx: CanvasRenderingContext2D, g: PlaceGeom, rng: () => number): void {
  const cx = g.rect.x + g.rect.w / 2;
  const cy = g.rect.y + 52;
  switch (g.landmark) {
    case 'tower': {
      drawPixelEllipse(ctx, cx, cy + 22, 22, 6, 'rgba(40,30,15,0.28)');
      // a small hill
      drawPixelEllipse(ctx, cx, cy + 16, 34, 12, '#86b84a');
      drawPixelEllipse(ctx, cx - 4, cy + 13, 24, 7, '#99cb5c');
      stoneBlock(ctx, cx - 12, cy - 56, 24, 76, rng);
      ctx.fillStyle = '#4e5563';
      ctx.fillRect(cx - 12, cy + 18, 24, 2);
      ctx.fillStyle = '#9aa1ad';
      for (let k = -12; k < 12; k += 6) ctx.fillRect(cx + k, cy - 60, 3, 4);
      ctx.fillStyle = '#3f4a5e';
      for (let k = 0; k < 10; k++) ctx.fillRect(cx - 14 + k, cy - 70 + k, 28 - k * 2, 1);
      ctx.fillStyle = '#2f3540';
      ctx.fillRect(cx - 3, cy - 36, 6, 6);
      ctx.fillRect(cx - 3, cy - 16, 6, 6);
      ctx.fillStyle = '#3f2c19';
      ctx.fillRect(cx - 5, cy + 8, 10, 12);
      drawPixelDisc(ctx, cx, cy + 8, 5, '#3f2c19');
      ctx.fillStyle = '#6e4f2e';
      ctx.fillRect(cx - 3, cy + 10, 6, 10);
      ctx.fillStyle = '#5d3d22';
      ctx.fillRect(cx - 1, cy - 76, 2, 16);
      break;
    }
    case 'cottage': {
      drawPixelEllipse(ctx, cx, cy + 20, 32, 6, 'rgba(40,30,15,0.28)');
      // thatched roof
      for (let k = 0; k < 18; k++) {
        ctx.fillStyle = k % 4 === 0 ? '#a8842f' : '#c9a24a';
        ctx.fillRect(cx - 14 - k, cy - 36 + k, 28 + k * 2, 1);
      }
      ctx.fillStyle = '#a8842f';
      ctx.fillRect(cx - 34, cy - 18, 68, 2);
      // chimney
      ctx.fillStyle = '#7d7069';
      ctx.fillRect(cx + 12, cy - 34, 6, 12);
      ctx.fillStyle = '#5f554e';
      ctx.fillRect(cx + 12, cy - 34, 6, 2);
      // walls
      ctx.fillStyle = '#e8d6ad';
      ctx.fillRect(cx - 28, cy - 16, 56, 34);
      ctx.fillStyle = '#5d3d22';
      ctx.fillRect(cx - 28, cy - 16, 2, 34);
      ctx.fillRect(cx + 26, cy - 16, 2, 34);
      ctx.fillRect(cx - 28, cy - 2, 56, 2);
      ctx.fillRect(cx - 28, cy + 16, 56, 2);
      // windows + door
      ctx.fillStyle = '#6b5634';
      ctx.fillRect(cx - 16, cy - 4, 10, 10);
      ctx.fillRect(cx + 6, cy - 4, 10, 10);
      ctx.fillStyle = '#3d4f66';
      ctx.fillRect(cx - 14, cy - 2, 6, 6);
      ctx.fillRect(cx + 8, cy - 2, 6, 6);
      ctx.fillStyle = '#4a2f1b';
      ctx.fillRect(cx - 5, cy + 2, 10, 16);
      ctx.fillStyle = '#74552e';
      ctx.fillRect(cx - 3, cy + 4, 6, 14);
      // garden fence + flowers
      ctx.fillStyle = '#a9743f';
      ctx.fillRect(cx - 36, cy + 22, 26, 2);
      ctx.fillRect(cx + 10, cy + 22, 26, 2);
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = '#8a5a33';
        ctx.fillRect(cx - 36 + k * 4, cy + 20, 2, 6);
        ctx.fillRect(cx + 10 + k * 4, cy + 20, 2, 6);
      }
      for (let k = 0; k < 8; k++) {
        ctx.fillStyle = ['#f2c14e', '#e2737f', '#e8a2c8', '#f2f2f2'][k % 4] ?? '#f2f2f2';
        ctx.fillRect(cx - 34 + Math.floor(rng() * 68), cy + 26 + Math.floor(rng() * 6), 2, 2);
      }
      break;
    }
    case 'ruins': {
      drawPixelEllipse(ctx, cx, cy + 18, 34, 8, '#86b84a');
      const col = (px: number, hgt: number): void => {
        stoneBlock(ctx, px - 4, cy + 14 - hgt, 8, hgt, rng);
        ctx.fillStyle = '#b4bbc6';
        ctx.fillRect(px - 5, cy + 14 - hgt, 10, 2);
        ctx.fillStyle = '#6e9a3e';
        ctx.fillRect(px - 3, cy + 10, 2, 2);
      };
      col(cx - 26, 30);
      col(cx - 10, 18);
      col(cx + 10, 36);
      col(cx + 26, 12);
      stoneBlock(ctx, cx - 30, cy + 10, 60, 6, rng);
      ctx.fillStyle = '#7c8088';
      ctx.fillRect(cx - 20, cy + 4, 12, 6);
      ctx.fillRect(cx + 4, cy + 2, 8, 8);
      break;
    }
    case 'stones': {
      drawPixelEllipse(ctx, cx, cy + 14, 36, 14, '#86b84a');
      drawPixelEllipse(ctx, cx, cy + 14, 24, 8, '#9c8d72');
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const sx = Math.round(cx + Math.cos(a) * 28);
        const sy = Math.round(cy + 14 + Math.sin(a) * 11);
        const hgt = 14 + Math.floor(rng() * 8);
        ctx.fillStyle = '#6f7785';
        ctx.fillRect(sx - 3, sy - hgt, 7, hgt);
        ctx.fillStyle = '#9aa1ad';
        ctx.fillRect(sx - 3, sy - hgt, 3, hgt);
        ctx.fillStyle = '#4e5563';
        ctx.fillRect(sx - 3, sy - 1, 7, 1);
      }
      ctx.fillStyle = '#8a4fb5';
      ctx.fillRect(cx - 1, cy + 11, 3, 3);
      break;
    }
    case 'grove': {
      drawTree(ctx, cx - 22, cy + 16, 11, rng);
      drawTree(ctx, cx + 20, cy + 12, 12, rng);
      drawTree(ctx, cx, cy + 26, 10, rng);
      ctx.fillStyle = '#7c8088';
      ctx.fillRect(cx - 6, cy + 2, 12, 8);
      ctx.fillStyle = '#9aa1ad';
      ctx.fillRect(cx - 6, cy + 2, 12, 2);
      break;
    }
    case 'camp': {
      drawPixelEllipse(ctx, cx, cy + 18, 34, 10, '#9c8d72');
      // tent
      for (let k = 0; k < 20; k++) {
        ctx.fillStyle = k % 5 === 0 ? '#b5483c' : '#d4685c';
        ctx.fillRect(cx - 24 - k, cy - 10 + k, 2 * k + 2, 1);
      }
      ctx.fillStyle = '#3a2d1f';
      ctx.fillRect(cx - 30, cy + 10, 36, 2);
      ctx.fillRect(cx - 24, cy + 2, 10, 8);
      // log seats + fire ring
      ctx.fillStyle = '#8a5a33';
      ctx.fillRect(cx + 4, cy + 20, 18, 4);
      ctx.fillStyle = '#6f7785';
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ctx.fillRect(Math.round(cx + 14 + Math.cos(a) * 8), Math.round(cy + 10 + Math.sin(a) * 4), 2, 2);
      }
      ctx.fillStyle = '#5d3d22';
      ctx.fillRect(cx + 10, cy + 9, 8, 2);
      break;
    }
    case 'windmill': {
      drawPixelEllipse(ctx, cx, cy + 20, 24, 6, 'rgba(40,30,15,0.28)');
      for (let k = 0; k < 42; k++) {
        ctx.fillStyle = k % 6 < 3 ? '#e8d6ad' : '#d8c49a';
        const hw = 8 + Math.floor(k * 0.3);
        ctx.fillRect(cx - hw, cy - 24 + k, hw * 2, 1);
      }
      ctx.fillStyle = '#8a4a2b';
      for (let k = 0; k < 8; k++) ctx.fillRect(cx - 12 + k, cy - 32 + k, 24 - k * 2, 1);
      ctx.fillStyle = '#4a2f1b';
      ctx.fillRect(cx - 4, cy + 6, 8, 12);
      ctx.fillStyle = '#3d4f66';
      ctx.fillRect(cx - 2, cy - 14, 4, 5);
      break;
    }
    default: {
      // shrine
      drawPixelEllipse(ctx, cx, cy + 16, 26, 8, '#9c8d72');
      stoneBlock(ctx, cx - 14, cy - 4, 28, 20, rng);
      ctx.fillStyle = '#5c6e8e';
      for (let k = 0; k < 8; k++) ctx.fillRect(cx - 18 + k, cy - 12 + k, 36 - k * 2, 1);
      ctx.fillStyle = '#2f3540';
      ctx.fillRect(cx - 5, cy, 10, 12);
      ctx.fillStyle = '#e9c46a';
      ctx.fillRect(cx - 1, cy - 20, 2, 8);
      ctx.fillRect(cx - 3, cy - 18, 6, 2);
      for (const t of g.torches) {
        ctx.fillStyle = '#5d3d22';
        ctx.fillRect(t.x - 1, t.y, 3, 12);
      }
    }
  }
}
