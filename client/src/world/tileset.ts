// LPC terrain atlas (client/public/assets/tiles/lpc/terrain_atlas.png, 32 px
// tiles, CC-BY-SA 3.0 — see the LICENSE.txt beside it). Loads the atlas, box-
// filters it to 0.5x once so one atlas tile covers one 16 px world tile, names
// the tiles the world uses and paints free-form cell masks with an 8 px
// quadrant autotiler. Callers keep drawing programmatic art until it is ready.

export const TILESET_FILE = 'assets/tiles/lpc/terrain_atlas.png';
/** Tile size in the source atlas. */
export const ATLAS_TILE = 32;
/** Tile size as drawn (0.5x) — equals the world TILE. */
export const TILE_PX = 16;
const QUARTER = TILE_PX / 2;

/** [col, row] of one atlas tile. */
export type TileRef = readonly [number, number];

/** A sprite spanning several atlas tiles (trees, boulders, fences). */
export interface SpriteRef {
  col: number;
  row: number;
  w: number;
  h: number;
  /** Opaque pixels [x, y, w, h] inside the drawn w*16 x h*16 rect (alpha >= 64 after the 0.5x filter). */
  box?: readonly [number, number, number, number];
}

/** An LPC terrain family: 2x2 inner corners stacked above a 3x3 blob, plus plain variants. */
export interface TerrainSet {
  blob: TileRef;
  inner: TileRef;
  plain: TileRef[];
}

const sp = (col: number, row: number, w = 1, h = 1, box?: readonly [number, number, number, number]): SpriteRef => ({ col, row, w, h, box });

// Sharm's base grass (cols 21-23) + the flowered variants under it.
export const GRASS_TILES: TileRef[] = [[21, 5], [22, 5], [23, 5], [22, 3]];
export const GRASS_FLOWER_TILES: TileRef[] = [[21, 11], [22, 11], [23, 11]];
/** Light dirt (roads): transparent outside the blob so it sits on the grass. Interior = blob centre, pebbled variants now and then ((15,5) is a shade darker and would checker). */
export const DIRT: TerrainSet = { blob: [15, 2], inner: [16, 0], plain: [[16, 3], [16, 3], [16, 3], [16, 5], [17, 5]] };
/** Darker tilled dirt (crop plots). */
export const DIRT_DARK: TerrainSet = { blob: [18, 2], inner: [19, 0], plain: [[18, 5], [19, 5], [20, 5]] };
/** Water with a muddy bank. */
export const WATER: TerrainSet = { blob: [9, 11], inner: [10, 9], plain: [[10, 12]] };

// Every rect below was checked against the atlas pixels (2026-10-15): complete
// sprites only. The brown autumn tree at (30,23) is cut off by the atlas edge
// and its trunk sits two rows lower, so it is not used. The 5th arg is the
// opaque box (precomputed so it also holds under file://, where the canvas is tainted).
export const SPR = {
  /** Foliage reaches the ground — these two have no separate trunk. */
  pine: sp(24, 15, 3, 3, [2, 2, 43, 46]),
  pineTall: sp(27, 15, 3, 4, [3, 10, 43, 46]),
  /** Tall pine with a visible trunk. */
  pineTrunked: sp(30, 0, 2, 5, [0, 2, 32, 74]),
  oak: sp(29, 28, 3, 4, [0, 3, 48, 59]),
  greenTree: sp(27, 29, 2, 3, [1, 1, 31, 46]),
  bushBig: sp(27, 12, 3, 3, [0, 8, 48, 40]),
  bushBerry: sp(9, 14, 1, 1, [0, 0, 16, 15]),
  bushDark: sp(11, 14, 2, 2, [1, 0, 24, 30]),
  bushDarkBig: sp(6, 26, 3, 3, [5, 4, 39, 39]),
  bushSmall: sp(6, 25, 1, 1, [4, 5, 8, 7]),
  stump: sp(23, 18, 1, 1, [2, 3, 13, 10]),
  stumpBig: sp(12, 12, 2, 2, [3, 5, 26, 21]),
  rockSand: sp(21, 21, 1, 1, [1, 1, 14, 14]),
  rockSand2: sp(24, 21, 1, 1, [0, 0, 16, 13]),
  rockSandBig: sp(26, 21, 2, 2, [1, 8, 31, 23]),
  rockSandBig2: sp(28, 21, 2, 2, [1, 10, 29, 21]),
  rockSandTall: sp(30, 21, 1, 2, [1, 7, 15, 24]),
  pebbles: sp(22, 21, 1, 1, [0, 2, 15, 12]),
  pebbles2: sp(23, 21, 1, 1, [1, 4, 9, 10]),
  pebbles3: sp(25, 21, 1, 1, [1, 1, 15, 14]),
  rockDarkBig: sp(27, 23, 2, 2, [1, 8, 31, 23]),
  rockDark: sp(26, 25, 1, 1, [1, 1, 14, 14]),
  rockDarkSmall: sp(29, 24, 1, 1, [0, 0, 16, 13]),
  pebblesDark: sp(29, 23, 1, 1, [1, 4, 9, 10]),
  pebblesDark2: sp(28, 25, 1, 1, [1, 4, 9, 10]),
  rockGreyBig: sp(27, 26, 2, 2, [1, 10, 29, 21]),
  rockGrey: sp(29, 26, 1, 2, [1, 7, 15, 24]),
  /** 2x2 cluster of lily pads with flowers. */
  lilies: sp(6, 30, 2, 2, [0, 0, 32, 31]),
  sprout: sp(9, 24, 1, 1, [6, 10, 5, 4]),
  sprout2: sp(9, 25, 1, 1, [4, 7, 9, 7]),
  seedling: sp(11, 24, 1, 1, [5, 7, 5, 7]),
  herb: sp(12, 26, 1, 1, [2, 7, 12, 8]),
  cabbage: sp(10, 27, 1, 1, [1, 3, 12, 12]),
  tomato: sp(12, 27, 1, 1, [0, 4, 16, 11]),
  tomato2: sp(11, 29, 1, 1, [1, 0, 13, 15]),
  berryBush: sp(13, 27, 1, 1, [0, 0, 16, 15]),
  potato: sp(9, 30, 1, 1, [2, 5, 12, 11]),
  carrot: sp(10, 30, 1, 1, [1, 0, 12, 16]),
  cucumber: sp(14, 29, 1, 1, [4, 6, 9, 8]),
  mound: sp(9, 29, 1, 1, [1, 5, 14, 10]),
} as const;
export type SpriteId = keyof typeof SPR;

let el: HTMLImageElement | null = null;
let atlas: HTMLCanvasElement | null = null;
let failed = false;
const waiters: Array<() => void> = [];

function ensureAtlas(): void {
  if (el || typeof Image === 'undefined') return;
  const img = new Image();
  el = img;
  img.decoding = 'async';
  img.onload = () => {
    // one box-filtered 0.5x copy; every blit after this is 1:1 and crisp
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width / 2);
    cv.height = Math.round(img.height / 2);
    const c = cv.getContext('2d');
    if (!c) {
      failed = true;
      return;
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, cv.width, cv.height);
    atlas = cv;
    for (const cb of waiters.splice(0)) cb();
  };
  img.onerror = () => {
    failed = true;
    waiters.length = 0;
  };
  // BASE_URL is '/' in dev and './' in the desktop build (dist loaded from file://).
  img.src = `${import.meta.env.BASE_URL}${TILESET_FILE}`;
}

/** True once the atlas can be drawn; also kicks off loading on first call. */
export function tilesetReady(): boolean {
  ensureAtlas();
  return atlas !== null && !failed;
}

/** Runs `cb` as soon as the atlas is drawable (now, if it already is; never if the load failed). */
export function onTilesetReady(cb: () => void): void {
  ensureAtlas();
  if (atlas) cb();
  else if (!failed) waiters.push(cb);
}

/** One 16 px tile with its top-left at (x, y). */
export function drawTile(ctx: CanvasRenderingContext2D, ref: TileRef, x: number, y: number): void {
  if (!atlas) return;
  ctx.drawImage(atlas, ref[0] * TILE_PX, ref[1] * TILE_PX, TILE_PX, TILE_PX, Math.round(x), Math.round(y), TILE_PX, TILE_PX);
}

export function spriteSize(s: SpriteRef): { w: number; h: number } {
  return { w: s.w * TILE_PX, h: s.h * TILE_PX };
}

/** World rect of a sprite's visible pixels when drawn at bottom-centre (cx, baseY); same rounding as drawSpriteAt. */
export function spriteBox(s: SpriteRef, cx: number, baseY: number): { x: number; y: number; w: number; h: number } {
  const { w, h } = spriteSize(s);
  const [bx, by, bw, bh] = s.box ?? [0, 0, w, h];
  return { x: Math.round(cx - w / 2) + bx, y: Math.round(baseY - h) + by, w: bw, h: bh };
}

/** A multi-tile sprite anchored at its bottom-centre (cx, baseY). */
export function drawSpriteAt(ctx: CanvasRenderingContext2D, s: SpriteRef, cx: number, baseY: number): void {
  if (!atlas) return;
  const { w, h } = spriteSize(s);
  ctx.drawImage(atlas, s.col * TILE_PX, s.row * TILE_PX, w, h, Math.round(cx - w / 2), Math.round(baseY - h), w, h);
}

/** Fills cols x rows world tiles with grass variants, a few of them flowered. */
export function paintGrass(ctx: CanvasRenderingContext2D, cols: number, rows: number, rng: () => number, flowerChance = 0.03): void {
  if (!atlas) return;
  const base = GRASS_TILES[0] ?? [22, 5];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const k = rng();
      const ref = k < flowerChance ? GRASS_FLOWER_TILES[Math.floor(rng() * GRASS_FLOWER_TILES.length)] : GRASS_TILES[Math.floor(rng() * GRASS_TILES.length)];
      drawTile(ctx, ref ?? base, tx * TILE_PX, ty * TILE_PX);
    }
  }
}

/**
 * Paints a cell mask (cols x rows world tiles, 1 = painted) with a terrain set.
 * Each cell is four 8 px quarters, each picked from the blob / inner-corner
 * tiles by the neighbours on its own side, so any mask gets rounded outer
 * edges, convex corners and concave inner corners.
 */
export function paintAutotile(ctx: CanvasRenderingContext2D, set: TerrainSet, mask: Uint8Array, cols: number, rows: number, rng: () => number): void {
  if (!atlas) return;
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : (mask[y * cols + x] ?? 0));
  const [bc, br] = set.blob;
  const [ic, ir] = set.inner;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!at(x, y)) continue;
      const plain = set.plain[Math.floor(rng() * set.plain.length)] ?? set.plain[0] ?? set.blob;
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const hx = qx === 0 ? -1 : 1;
          const vy = qy === 0 ? -1 : 1;
          const side = at(x + hx, y);
          const vert = at(x, y + vy);
          const diag = at(x + hx, y + vy);
          let col: number;
          let row: number;
          if (side && vert && diag) {
            col = plain[0];
            row = plain[1];
          } else if (side && vert) {
            col = ic + (1 - qx);
            row = ir + (1 - qy);
          } else if (vert) {
            col = bc + 2 * qx;
            row = br + 1;
          } else if (side) {
            col = bc + 1;
            row = br + 2 * qy;
          } else {
            col = bc + 2 * qx;
            row = br + 2 * qy;
          }
          ctx.drawImage(atlas, col * TILE_PX + qx * QUARTER, row * TILE_PX + qy * QUARTER, QUARTER, QUARTER, x * TILE_PX + qx * QUARTER, y * TILE_PX + qy * QUARTER, QUARTER, QUARTER);
        }
      }
    }
  }
}

/** Marks every cell whose centre lies inside the ellipse (cx, cy, rx, ry). */
export function ellipseMask(mask: Uint8Array, cols: number, rows: number, cx: number, cy: number, rx: number, ry: number): void {
  const x0 = Math.max(0, Math.floor((cx - rx) / TILE_PX));
  const x1 = Math.min(cols - 1, Math.ceil((cx + rx) / TILE_PX));
  const y0 = Math.max(0, Math.floor((cy - ry) / TILE_PX));
  const y1 = Math.min(rows - 1, Math.ceil((cy + ry) / TILE_PX));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x * TILE_PX + TILE_PX / 2 - cx) / rx;
      const dy = (y * TILE_PX + TILE_PX / 2 - cy) / ry;
      if (dx * dx + dy * dy <= 1) mask[y * cols + x] = 1;
    }
  }
}
