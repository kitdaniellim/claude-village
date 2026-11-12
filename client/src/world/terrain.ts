// Builds the static world layer once per layout: grass, roads, every place's
// art and the scattered decorations. Painted from the LPC tile atlas
// (world/tileset.ts) — the canvas is repainted in place the moment the atlas
// loads, and drawn with programmatic pixels until then. Returns the geometry
// the live layers need (place geoms, roads, sway tufts, pond, window glows).

import type { PlaceDef } from './registry';
import { TAVERN_PLACE } from './registry';
import { DEFAULT_PLACE_TILES, TAVERN_TILE, TILE, TILES_X, TILES_Y, WILD_SLOTS, WORLD_H, WORLD_SEED, WORLD_W, footprintFor } from './constants';
import type { TilePos } from './constants';
import { rectsOverlap } from './geometry';
import { computePlaceGeom, drawPlaceStatic, drawTree } from './places';
import type { PlaceGeom } from './places';
import { drawPixelDisc, drawPixelEllipse, mulberry32 } from './pixel';
import type { Pt, Rect } from './pixel';
import { ROAD_BLEED, buildRoads, paintRoads, rectNearRoad, roadPaintedAt, roadSdAt } from './roads';
import type { RoadNet } from './roads';
import { DIRT_DARK, SPR, WATER, drawSpriteAt, ellipseMask, onTilesetReady, paintAutotile, paintGrass, spriteBox, tilesetReady } from './tileset';
import type { SpriteRef } from './tileset';
import { biomeOfPlace, biomeWeight, buildBiomes, dominantBiome, paintBiomeOverlay, paintGroundFlowers, paintLavaPools, placeLavaPools } from './biomes';
import type { BiomeField, BiomeId, LavaPool } from './biomes';
import { buildWater, paintWater, waterAt, waterHitsRect } from './water';
import type { WaterGeom } from './water';

export type LayoutTiles = Record<string, TilePos>;

export interface World {
  canvas: HTMLCanvasElement;
  tavern: PlaceGeom;
  places: PlaceGeom[];
  byId: Map<string, PlaceGeom>;
  roads: RoadNet;
  tufts: Pt[];
  pond: { x: number; y: number; rx: number; ry: number } | null;
  /** Ground nobody should stand on: tree trunks, rocks, boulders (filled by the decoration pass). */
  blockers: Rect[];
  /** Live blockers set each frame (the Simone dragon while she is down). */
  dynamicBlockers: Rect[];
  /** Every decoration's full drawn box (trees with canopy, bushes, rocks, the pond): for big bodies like the dragon. */
  decor: Rect[];
  /**
   * The river (see water.ts). `water.mask` is the coarse (4 px cell) walk-block grid, `water.depth` a per-pixel
   * grid (> 0 inside the river, index y * WORLD_W + x), `water.path` / `water.halfW` the centreline and half-widths,
   * `water.bridges` the decks (walkable) and `water.shine` the static glint spots the ambient layer can animate.
   * Query with `waterAt(world.water, x, y)` / `waterHitsRect`.
   */
  water: WaterGeom;
  /** Static lava pools beside every lair (ellipses, world px): the ambient layer can add a glow over them. Not walkable. */
  lava: LavaPool[];
  /** Soft biome blend per place (see biomes.ts): `dominantBiome(world.biomes, x, y)` / `biomeWeight(...)`. */
  biomes: BiomeField;
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
  claim(TAVERN_PLACE, layout['tavern'] ?? DEFAULT_PLACE_TILES['tavern'] ?? TAVERN_TILE);
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
  const tavern = computePlaceGeom(TAVERN_PLACE, tiles.get('tavern') ?? TAVERN_TILE);
  const places: PlaceGeom[] = [tavern, ...defs.map((d) => computePlaceGeom(d, tiles.get(d.id) ?? { tx: 2, ty: 2 }))];
  const byId = new Map(places.map((p) => [p.id, p]));
  const roads = buildRoads(tavern, places, WORLD_SEED);
  const biomes = buildBiomes(places, WORLD_SEED);
  const water = buildWater(places, roads, WORLD_SEED);
  const lava = placeLavaPools(places, WORLD_SEED, (box) => {
    const pl = tavern.plaza;
    if (pl && box.x < pl.c.x + pl.r && box.x + box.w > pl.c.x - pl.r && box.y < pl.c.y + pl.r && box.y + box.h > pl.c.y - pl.r) return false;
    if (box.x < 4 || box.y < 4 || box.x + box.w > WORLD_W - 4 || box.y + box.h > WORLD_H - 4) return false;
    return !places.some((g) => rectsOverlap(box, g.rect)) && !rectNearRoad(roads, box, ROAD_BLEED + 6) && !waterHitsRect(water, box, 8);
  });

  const cv = document.createElement('canvas');
  cv.width = WORLD_W;
  cv.height = WORLD_H;
  const ctx = cv.getContext('2d');
  const world: World = { canvas: cv, tavern, places, byId, roads, tufts: [], pond: null, blockers: [], dynamicBlockers: [], decor: [], water, lava, biomes };
  if (!ctx) return world;
  paintWorld(ctx, world);
  // the atlas normally lands within a frame or two: repaint this same canvas when it does
  if (!tilesetReady()) onTilesetReady(() => paintWorld(ctx, world));
  return world;
}

/** Paints the whole static layer (deterministic from WORLD_SEED, so a repaint is identical apart from the art source). */
function paintWorld(ctx: CanvasRenderingContext2D, world: World): void {
  const tiles = tilesetReady();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, WORLD_W, WORLD_H);
  ctx.imageSmoothingEnabled = false;
  world.tufts.length = 0;
  world.pond = null;
  world.blockers.length = 0;
  world.decor.length = 0;
  const rng = mulberry32(WORLD_SEED);
  if (tiles) paintTileGround(ctx, world, rng);
  else paintPixelGround(ctx, world, rng);
  paintWater(ctx, world.water, WORLD_SEED);

  const ordered = [...world.places].sort((a, b) => a.rect.y - b.rect.y);
  for (const g of ordered) drawPlaceStatic(ctx, g);

  paintDecorations(ctx, world, tiles);
}

// ── ground ───────────────────────────────────────────────────────────────────

function paintTileGround(ctx: CanvasRenderingContext2D, world: World, rng: () => number): void {
  paintGrass(ctx, TILES_X, TILES_Y, rng, 0.035);
  // broad light / dark drifts so the tiling never reads as a flat carpet
  const s1 = rng() * Math.PI * 2;
  const s2 = rng() * Math.PI * 2;
  for (let y = 0; y < WORLD_H; y += 4) {
    for (let x = 0; x < WORLD_W; x += 4) {
      const v = Math.sin(x * 0.011 + s1) + Math.sin(y * 0.015 + s2) + Math.sin((x * 0.5 + y) * 0.009 + s1);
      if (v > 1.4) {
        ctx.fillStyle = `rgba(255,250,200,${Math.min(0.08, (v - 1.4) * 0.12).toFixed(3)})`;
        ctx.fillRect(x, y, 4, 4);
      } else if (v < -1.5) {
        ctx.fillStyle = `rgba(10,30,40,${Math.min(0.09, (-1.5 - v) * 0.12).toFixed(3)})`;
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }
  paintBiomes(ctx, world);
  // roads: one distance-field ribbon for main + side paths so junctions merge cleanly
  paintRoads(ctx, world.roads);
}

/** Biome tint, flowers and lava pools over the grass (both art sources), before the roads go down. */
function paintBiomes(ctx: CanvasRenderingContext2D, world: World): void {
  paintBiomeOverlay(ctx, world.biomes);
  paintGroundFlowers(ctx, world.biomes);
  paintLavaPools(ctx, world.lava, WORLD_SEED);
}

/** Pre-atlas grass + roads (also the fallback if the atlas fails to load). */
function paintPixelGround(ctx: CanvasRenderingContext2D, world: World, rng: () => number): void {
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
  paintBiomes(ctx, world);
  paintRoads(ctx, world.roads);
}

// ── decorations ──────────────────────────────────────────────────────────────

const TREE_SMALL: SpriteRef[] = [SPR.greenTree, SPR.bushBig, SPR.greenTree];
const TREE_MID: SpriteRef[] = [SPR.pine, SPR.greenTree, SPR.pineTrunked, SPR.pine];
const TREE_BIG: SpriteRef[] = [SPR.oak, SPR.pineTall, SPR.pineTrunked, SPR.pine];
const BUSHES: SpriteRef[] = [SPR.bushBerry, SPR.bushDark, SPR.bushSmall, SPR.bushDarkBig, SPR.bushBerry, SPR.bushSmall];
const PLANTS: SpriteRef[] = [SPR.sprout, SPR.seedling, SPR.herb, SPR.sprout2];
const ROCKS: SpriteRef[] = [SPR.rockSand, SPR.rockSand2, SPR.rockDark, SPR.rockGrey, SPR.rockDarkSmall, SPR.pebblesDark, SPR.rockSandTall];
const CROPS: SpriteRef[] = [SPR.cabbage, SPR.tomato, SPR.carrot, SPR.potato, SPR.cucumber, SPR.berryBush, SPR.sprout2, SPR.tomato2];
const DUNGEON_ROCKS: SpriteRef[] = [SPR.rockDarkBig, SPR.rockDark, SPR.rockGreyBig, SPR.rockGrey, SPR.rockDarkSmall, SPR.pebblesDark2];
const LAIR_ROCKS: SpriteRef[] = [SPR.rockSandBig, SPR.rockSandBig2, SPR.rockSandTall, SPR.rockGrey, SPR.rockSand, SPR.rockDark];

const PINES: SpriteRef[] = [SPR.pine, SPR.pineTall, SPR.pineTrunked, SPR.pine];
const LEAFY: SpriteRef[] = [SPR.greenTree, SPR.oak, SPR.greenTree, SPR.bushBig];
const STONE_ROCKS: SpriteRef[] = [SPR.rockGreyBig, SPR.rockGrey, SPR.rockDark, SPR.rockGrey, SPR.rockDarkSmall, SPR.pebblesDark];
const DARK_ROCKS: SpriteRef[] = [SPR.rockDarkBig, SPR.rockDark, SPR.rockDarkSmall, SPR.rockDarkBig, SPR.pebblesDark2, SPR.rockGreyBig];

const pick = <T,>(arr: T[], rng: () => number, fallback: T): T => arr[Math.floor(rng() * arr.length)] ?? fallback;

/** The visible footprint of one placed decoration (world px). */
export interface DecorBox extends Rect {
  kind: 'tree' | 'bush' | 'plant' | 'rock' | 'boulder' | 'plot' | 'pond';
}

/** Clear px kept between any two decorations; wider between tree canopies and around the pond. */
export const DECOR_GAP = 4;
export const DECOR_TREE_GAP = 6;
export const DECOR_POND_GAP = 10;

export function decorGap(a: DecorBox, b: DecorBox): number {
  if (a.kind === 'pond' || b.kind === 'pond') return DECOR_POND_GAP;
  return a.kind === 'tree' && b.kind === 'tree' ? DECOR_TREE_GAP : DECOR_GAP;
}

/**
 * Deterministic decoration placement shared by both art sources. Every piece
 * claims its footprint in one occupancy list, so nothing is drawn over anything else.
 */
function paintDecorations(ctx: CanvasRenderingContext2D, world: World, tiles: boolean): void {
  const { places, roads } = world;
  const plaza = world.tavern.plaza;
  const placed: DecorBox[] = [];

  /** Box lies inside the world and `margin` px clear of places (except `own`), the plaza and the painted road ribbon. */
  const clearGround = (b: Rect, margin: number, own?: PlaceGeom): boolean => {
    if (b.x < 2 || b.y < 2 || b.x + b.w > WORLD_W - 2 || b.y + b.h > WORLD_H - 2) return false;
    const x0 = b.x - margin;
    const y0 = b.y - margin;
    const x1 = b.x + b.w + margin;
    const y1 = b.y + b.h + margin;
    for (const g of places) {
      const r = g.rect;
      if (g !== own && x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return false;
    }
    if (plaza) {
      const ry = plaza.r * 0.82;
      if (x1 > plaza.c.x - plaza.r && x0 < plaza.c.x + plaza.r && y1 > plaza.c.y - ry && y0 < plaza.c.y + ry) return false;
    }
    const grown: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (waterHitsRect(world.water, grown, 4)) return false;
    for (const l of world.lava) if (x1 > l.x - l.rx - 4 && x0 < l.x + l.rx + 4 && y1 > l.y - l.ry - 4 && y0 < l.y + l.ry + 4) return false;
    return !rectNearRoad(roads, grown, ROAD_BLEED);
  };
  const biomeAt = (x: number, y: number): BiomeId => dominantBiome(world.biomes, x, y);
  const weight = (x: number, y: number, id: BiomeId): number => biomeWeight(world.biomes, x, y, id);
  /** Probability gate by biome: true when a decoration of this class may stand at (x, y). */
  const allow = (x: number, y: number, odds: Partial<Record<BiomeId, number>>, rng: () => number): boolean => (odds[biomeAt(x, y)] ?? 1) > rng();
  const free = (b: DecorBox): boolean =>
    placed.every((o) => {
      const gap = decorGap(b, o);
      return b.x >= o.x + o.w + gap || o.x >= b.x + b.w + gap || b.y >= o.y + o.h + gap || o.y >= b.y + b.h + gap;
    });
  const fits = (b: DecorBox, margin: number, own?: PlaceGeom): boolean => clearGround(b, margin, own) && free(b);
  const sbox = (spr: SpriteRef, cx: number, baseY: number, kind: DecorBox['kind']): DecorBox => ({ ...spriteBox(spr, cx, baseY), kind });
  const deco = mulberry32(WORLD_SEED ^ 0x51f15eed);

  // one pond first, in the clearest pocket (the tile pond is larger so its banks read)
  const pondSizes: Array<[number, number]> = tiles ? [[60, 34], [50, 28], [38, 22]] : [[30, 17]];
  for (const [rx, ry] of pondSizes) {
    for (let i = 0; i < 200 && !world.pond; i++) {
      // centred on a tile corner so the cell-mask oval comes out symmetric
      const x = Math.round((80 + deco() * (WORLD_W - 160)) / TILE) * TILE;
      const y = Math.round((80 + deco() * (WORLD_H - 160)) / TILE) * TILE;
      // tile cells whose centre is inside the ellipse reach up to 8 px past it
      const pad = tiles ? 8 : 2;
      const box: DecorBox = { x: x - rx - pad, y: y - ry - pad, w: 2 * (rx + pad), h: 2 * (ry + pad), kind: 'pond' };
      if (!fits(box, 12) || !allow(x, y, { stone: 0.15, badlands: 0, scorched: 0 }, deco)) continue;
      placed.push(box);
      world.pond = { x, y, rx, ry };
      if (tiles) paintTilePond(ctx, x, y, rx, ry, deco);
      else paintPixelPond(ctx, x, y, rx, ry, deco);
    }
    if (world.pond) break;
  }

  // crop plots: tilled dirt on the tile grid, one plant per cell
  let plots = 0;
  const plotMask = tiles ? new Uint8Array(TILES_X * TILES_Y) : null;
  const plotPlants: Array<{ x: number; y: number; spr: SpriteRef }> = [];
  const farm = places.find((g) => biomeOfPlace(g) === 'lush') ?? null;
  for (let i = 0; i < 400 && plots < 3; i++) {
    const cols = 4 + Math.floor(deco() * 3);
    const rowsN = 3 + Math.floor(deco() * 2);
    const pw = cols * 8;
    const ph = rowsN * 7;
    let x = 24 + Math.floor(deco() * (WORLD_W - 48 - pw));
    let y = 24 + Math.floor(deco() * (WORLD_H - 48 - ph));
    if (farm && i < 300) {
      // fields belong around the farm town, on the lush ground
      x = Math.round(farm.rect.x - 150 + deco() * (farm.rect.w + 300));
      y = Math.round(farm.rect.y - 120 + deco() * (farm.rect.h + 240));
      if (x < 24 || y < 24 || x + pw > WORLD_W - 24 || y + ph > WORLD_H - 24 || weight(x + pw / 2, y + ph / 2, 'lush') < 0.35) continue;
    }
    if (plotMask) {
      const tx0 = Math.round(x / TILE);
      const ty0 = Math.round(y / TILE);
      const tw = Math.max(2, Math.round(pw / TILE));
      const th = Math.max(2, Math.round(ph / TILE));
      const box: DecorBox = { x: tx0 * TILE, y: ty0 * TILE, w: tw * TILE, h: th * TILE, kind: 'plot' };
      if (!fits(box, 6)) continue;
      plots++;
      placed.push(box);
      for (let ty = ty0; ty < ty0 + th; ty++) {
        for (let tx = tx0; tx < tx0 + tw; tx++) {
          plotMask[ty * TILES_X + tx] = 1;
          plotPlants.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE - 1, spr: pick(CROPS, deco, SPR.cabbage) });
        }
      }
      continue;
    }
    const box: DecorBox = { x: x - 2, y: y - 2, w: pw + 4, h: ph + 6, kind: 'plot' };
    if (!fits(box, 6)) continue;
    plots++;
    placed.push(box);
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
  if (plotMask) {
    paintAutotile(ctx, DIRT_DARK, plotMask, TILES_X, TILES_Y, deco);
    for (const p of plotPlants) drawSpriteAt(ctx, p.spr, p.x, p.y);
  }

  // tree clusters: 2-3 trees side by side with clear gaps between canopies (now and then a lone tree)
  let clusters = 0;
  for (let i = 0; i < 900 && clusters < 26; i++) {
    const x = 24 + Math.floor(deco() * (WORLD_W - 48));
    const y = 44 + Math.floor(deco() * (WORLD_H - 70));
    // biome decides whether trees grow here at all (rare in the stone / ash / badlands, pines up high)
    const biome = biomeAt(x, y);
    if (!allow(x, y, { stone: 0.3, badlands: 0.02, scorched: 0.02, meadow: 0.55, worn: 0.5 }, deco)) continue;
    const count = 2 + (deco() < 0.45 ? 1 : 0);
    const loneOk = deco() < 0.25;
    const group: Array<{ x: number; y: number; r: number; spr: SpriteRef; box: DecorBox }> = [];
    const treeBox = (spr: SpriteRef, r: number, sx: number, sy: number): DecorBox =>
      tiles ? sbox(spr, sx, sy + 4, 'tree') : { x: sx - r - 4, y: sy - 2 * r - 6, w: 2 * r + 8, h: 2 * r + 10, kind: 'tree' };
    for (let n = 0; n < count; n++) {
      const r = 8 + Math.floor(deco() * 5);
      const spr =
        biome === 'stone' || biome === 'badlands' || biome === 'scorched'
          ? pick(PINES, deco, SPR.pine)
          : biome === 'lush' || biome === 'meadow'
            ? pick(LEAFY, deco, SPR.greenTree)
            : r >= 12
              ? pick(TREE_BIG, deco, SPR.pine)
              : r >= 10
                ? pick(TREE_MID, deco, SPR.pine)
                : pick(TREE_SMALL, deco, SPR.greenTree);
      const w = treeBox(spr, r, 0, 0).w;
      for (let t = 0; t < 4; t++) {
        // first tree at the cluster centre, the rest just beside a tree already in the group
        const nb = group[Math.floor(deco() * group.length)];
        const dir = (deco() < 0.5 ? -1 : 1) * (t % 2 === 0 ? 1 : -1);
        const sx = nb ? Math.round(nb.box.x + nb.box.w / 2 + dir * (nb.box.w / 2 + w / 2 + DECOR_TREE_GAP + 1 + deco() * 8)) : x;
        const sy = nb ? nb.y + Math.floor((deco() - 0.5) * 30) : y;
        const box = treeBox(spr, r, sx, sy);
        if (!fits(box, 4)) continue;
        // claimed right away so the cluster's next tree keeps its distance
        placed.push(box);
        group.push({ x: sx, y: sy, r, spr, box });
        break;
      }
    }
    if (group.length < 2 && !(group.length === 1 && loneOk)) {
      for (const s of group) placed.splice(placed.indexOf(s.box), 1);
      continue;
    }
    clusters++;
    group.sort((u, v) => u.y - v.y);
    for (const s of group) {
      if (tiles) drawSpriteAt(ctx, s.spr, s.x, s.y + 4);
      else drawTree(ctx, s.x, s.y, s.r, deco);
    }
  }

  // boulders ringing the dungeon and lair hills (tile art only), never stacked
  if (tiles) {
    for (const g of places) {
      const home = biomeOfPlace(g);
      if (home !== 'badlands' && home !== 'scorched' && home !== 'stone') continue;
      const bank = home === 'badlands' ? DUNGEON_ROCKS : home === 'scorched' ? LAIR_ROCKS : STONE_ROCKS;
      const r = g.rect;
      let n = 0;
      for (let i = 0; i < 100 && n < (home === 'stone' ? 10 : 8); i++) {
        // a point just outside one of the four sides
        const side = Math.floor(deco() * 4);
        const along = deco();
        const out = 6 + deco() * 14;
        const x = side === 0 || side === 2 ? r.x + along * r.w : side === 1 ? r.x + r.w + out : r.x - out;
        const y = side === 1 || side === 3 ? r.y + along * r.h : side === 2 ? r.y + r.h + out : r.y - out;
        const spr = pick(bank, deco, SPR.rockGrey);
        const box = sbox(spr, Math.round(x), Math.round(y) + 6, 'boulder');
        if (!fits(box, 6, g)) continue;
        n++;
        placed.push(box);
        drawSpriteAt(ctx, spr, Math.round(x), Math.round(y) + 6);
      }
    }
  }

  // mossy rocks, one per spot
  let rocks = 0;
  for (let i = 0; i < 700 && rocks < 44; i++) {
    const x = 16 + Math.floor(deco() * (WORLD_W - 32));
    const y = 16 + Math.floor(deco() * (WORLD_H - 32));
    const w = 6 + Math.floor(deco() * 5);
    const h = 4 + Math.floor(deco() * 3);
    // rocks gather in the stone / badland / ash country and thin out in the green
    if (!allow(x, y, { base: 0.22, lush: 0.08, meadow: 0.1, worn: 0.1, stone: 0.9, badlands: 1, scorched: 1 }, deco)) continue;
    const rb = biomeAt(x, y);
    const spr = tiles ? pick(rb === 'stone' ? STONE_ROCKS : rb === 'badlands' || rb === 'scorched' ? DARK_ROCKS : ROCKS, deco, SPR.rockGrey) : null;
    const box: DecorBox = spr ? sbox(spr, x, y + h, 'rock') : { x: x - w, y: y - h, w: w * 2, h: h * 2 + 1, kind: 'rock' };
    if (!fits(box, 6)) continue;
    rocks++;
    placed.push(box);
    if (spr) {
      drawSpriteAt(ctx, spr, x, y + h);
      continue;
    }
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

  // bushes
  let bushes = 0;
  for (let i = 0; i < 500 && bushes < 26; i++) {
    const x = 12 + Math.floor(deco() * (WORLD_W - 24));
    const y = 16 + Math.floor(deco() * (WORLD_H - 28));
    if (!allow(x, y, { stone: 0.12, badlands: 0.04, scorched: 0, lush: 1.2, meadow: 0.8 }, deco)) continue;
    const spr = pick(BUSHES, deco, SPR.bushBerry);
    const box: DecorBox = tiles ? sbox(spr, x, y + 6, 'bush') : { x: x - 6, y: y - 6, w: 12, h: 12, kind: 'bush' };
    if (!fits(box, 4)) continue;
    bushes++;
    placed.push(box);
    if (tiles) {
      drawSpriteAt(ctx, spr, x, y + 6);
      continue;
    }
    drawPixelDisc(ctx, x, y, 5, '#4f7d35');
    drawPixelDisc(ctx, x - 1, y - 2, 3, '#639a40');
    ctx.fillStyle = '#7ab84d';
    ctx.fillRect(x - 1, y - 3, 2, 1);
  }

  // small plants / flowers (the grass tiles already carry flowered variants)
  const flowerColors = ['#f2f2f2', '#f2c14e', '#e2737f', '#e8a2c8'];
  let plants = 0;
  for (let i = 0; i < 500 && plants < (tiles ? 56 : 90); i++) {
    const x = 12 + Math.floor(deco() * (WORLD_W - 24));
    const y = 14 + Math.floor(deco() * (WORLD_H - 24));
    if (!allow(x, y, { stone: 0.08, badlands: 0.04, scorched: 0, base: 0.5 }, deco)) continue;
    const spr = pick(PLANTS, deco, SPR.sprout);
    const box: DecorBox = tiles ? sbox(spr, x, y + 6, 'plant') : { x: x - 1, y: y - 2, w: 2, h: 4, kind: 'plant' };
    if (!fits(box, 3)) continue;
    plants++;
    placed.push(box);
    if (tiles) {
      drawSpriteAt(ctx, spr, x, y + 6);
      continue;
    }
    ctx.fillStyle = '#4f7d35';
    ctx.fillRect(x, y, 1, 2);
    ctx.fillStyle = flowerColors[Math.floor(deco() * flowerColors.length)] ?? '#f2f2f2';
    ctx.fillRect(x - 1, y - 2, 2, 2);
  }

  // grass tufts that sway per frame (positions only; drawn live), never on a decoration
  for (let i = 0; i < 90; i++) {
    const x = 10 + Math.floor(deco() * (WORLD_W - 20));
    const y = 10 + Math.floor(deco() * (WORLD_H - 20));
    if (!clearGround({ x: x - 2, y: y - 4, w: 4, h: 5 }, 3)) continue;
    if (weight(x, y, 'stone') + weight(x, y, 'badlands') + weight(x, y, 'scorched') > 0.25) continue;
    if (placed.some((o) => x > o.x - 3 && x < o.x + o.w + 3 && y > o.y - 3 && y < o.y + o.h + 6)) continue;
    world.tufts.push({ x, y });
  }

  // blockers for actors: tree trunks (lower part of the sprite box), rocks and boulders whole
  for (const b of placed) {
    if (b.kind !== 'plot' && b.kind !== 'plant') world.decor.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    if (b.kind === 'tree') world.blockers.push({ x: b.x + b.w * 0.25, y: b.y + b.h * 0.65, w: b.w * 0.5, h: b.h * 0.35 });
    else if (b.kind === 'rock' || b.kind === 'boulder') world.blockers.push({ x: b.x, y: b.y, w: b.w, h: b.h });
  }

  // dev-only aid: headless checks read the footprints to assert nothing overlaps
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as Window & { __rtsDecor?: unknown }).__rtsDecor = {
      tiles,
      gaps: { base: DECOR_GAP, tree: DECOR_TREE_GAP, pond: DECOR_POND_GAP },
      boxes: placed.map((b) => ({ ...b })),
      pond: world.pond,
      places: places.map((g) => ({ id: g.id, kind: g.kind, x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h })),
      roads: [...roads.main.values(), ...roads.side].map((r) => ({ id: r.id, kind: r.kind, width: r.width, pts: r.pts.map((p) => ({ ...p })) })),
      roadSd: (x: number, y: number) => roadSdAt(roads, x, y),
      roadPainted: (x: number, y: number) => roadPaintedAt(roads, x, y),
    };
  }
}

/** Tile pond: autotiled water plus at most one lily cluster, only where it sits wholly in open water. */
function paintTilePond(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rng: () => number): void {
  const mask = new Uint8Array(TILES_X * TILES_Y);
  ellipseMask(mask, TILES_X, TILES_Y, x, y, rx, ry);
  paintAutotile(ctx, WATER, mask, TILES_X, TILES_Y, rng);
  const wet = (tx: number, ty: number): boolean => tx >= 0 && ty >= 0 && tx < TILES_X && ty < TILES_Y && mask[ty * TILES_X + tx] === 1;
  // a cell with water on all 8 sides is clear of the muddy bank
  const open = (tx: number, ty: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!wet(tx + dx, ty + dy)) return false;
    return true;
  };
  const spots: Array<{ tx: number; ty: number }> = [];
  for (let ty = Math.floor((y - ry) / TILE); ty <= Math.ceil((y + ry) / TILE); ty++) {
    for (let tx = Math.floor((x - rx) / TILE); tx <= Math.ceil((x + rx) / TILE); tx++) {
      if (open(tx, ty) && open(tx + 1, ty) && open(tx, ty + 1) && open(tx + 1, ty + 1)) spots.push({ tx, ty });
    }
  }
  // prefer an off-centre spot so open water stays visible in the middle
  const side = spots.filter((s) => Math.abs(s.tx + 1 - x / TILE) >= 1);
  const s = pick(side.length ? side : spots, rng, null);
  if (s) drawSpriteAt(ctx, SPR.lilies, s.tx * TILE + TILE, s.ty * TILE + 2 * TILE);
}

/** Pre-atlas pond: layered ellipses, a few ripple lines and three reeds on the bank. */
function paintPixelPond(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rng: () => number): void {
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
  for (let k = 0; k < 3; k++) {
    const a = rng() * Math.PI * 2;
    const px = Math.round(x + Math.cos(a) * (rx - 1));
    const py = Math.round(y + Math.sin(a) * (ry - 1));
    ctx.fillStyle = '#5f9636';
    ctx.fillRect(px, py - 3, 1, 4);
    ctx.fillRect(px + 1, py - 2, 1, 3);
  }
}

/** Tile-aligned rect of a place footprint, for editor outlines / drag clamping. */
export function footprintRect(kind: PlaceDef['kind'], id: string, tile: TilePos): Rect {
  const fp = footprintFor(kind, id);
  return { x: tile.tx * TILE, y: tile.ty * TILE, w: fp.tw * TILE, h: fp.th * TILE };
}

// ── walkability (actors: fights, prowls, dodges, war posts) ──────────────────

/**
 * True when an actor's feet at (x, y) are on open ground: inside the world (with a border), off the pond
 * (with `margin` px of bank), off tree trunks / rocks and off building footprints. Cities, the plaza and
 * roads stay walkable: heroes work there.
 */
export function isWalkable(world: World, x: number, y: number, margin = 8): boolean {
  if (x < 16 || x > WORLD_W - 16 || y < 28 || y > WORLD_H - 10) return false;
  const p = world.pond;
  if (p) {
    const dx = (x - p.x) / (p.rx + margin);
    const dy = (y - p.y) / (p.ry + margin);
    if (dx * dx + dy * dy < 1) return false;
  }
  // the river (bank included) is not walkable except on a bridge deck; lava pools never
  if (waterAt(world.water, x, y, Math.min(margin, 3))) return false;
  for (const l of world.lava) {
    const dx = (x - l.x) / (l.rx + 3);
    const dy = (y - l.y) / (l.ry + 3);
    if (dx * dx + dy * dy < 1) return false;
  }
  for (const b of world.blockers) if (x > b.x - 2 && x < b.x + b.w + 2 && y > b.y - 2 && y < b.y + b.h + 2) return false;
  for (const b of world.dynamicBlockers) if (x > b.x - 4 && x < b.x + b.w + 4 && y > b.y - 4 && y < b.y + b.h + 4) return false;
  for (const g of world.places) {
    for (const bd of g.buildings) {
      const r = bd.rect;
      if (x > r.x - 2 && x < r.x + r.w + 2 && y > r.y && y < r.y + r.h + 1) return false;
    }
  }
  return true;
}

/** True when a large body's whole drawn box overlaps no decoration (canopies included), place or banner. */
export function bodyClear(world: World, r: Rect): boolean {
  const hit = (b: Rect): boolean => r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y;
  if (r.x < 4 || r.y < 4 || r.x + r.w > WORLD_W - 4 || r.y + r.h > WORLD_H - 4) return false;
  if (world.decor.some(hit) || world.places.some((g) => hit(g.rect))) return false;
  // place-name banners hang just above their anchor (about 100 x 28 px at fit zoom)
  if (world.places.some((g) => hit({ x: g.bannerAt.x - 52, y: g.bannerAt.y - 30, w: 104, h: 34 }))) return false;
  if (waterHitsRect(world.water, r, 4)) return false;
  if (world.lava.some((l) => hit({ x: l.x - l.rx - 3, y: l.y - l.ry - 3, w: 2 * l.rx + 6, h: 2 * l.ry + 6 }))) return false;
  const p = world.pond;
  if (p && hit({ x: p.x - p.rx - 6, y: p.y - p.ry - 6, w: 2 * (p.rx + 6), h: 2 * (p.ry + 6) })) return false;
  return true;
}

/** `p` if walkable, else the closest walkable point found on rings up to `maxR` px out (or `p` when none). */
export function nearestWalkable(world: World, p: Pt, margin = 8, maxR = 96): Pt {
  if (isWalkable(world, p.x, p.y, margin)) return p;
  for (let r = 4; r <= maxR; r += 4) {
    const n = Math.max(8, Math.round(r / 2));
    let best: Pt | null = null;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
      if (isWalkable(world, q.x, q.y, margin)) {
        best = q;
        break;
      }
    }
    if (best) return best;
  }
  return p;
}
