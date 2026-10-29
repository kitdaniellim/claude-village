// Sprite-sheet dragon for the lair perch: loads ZaPaper's west-facing "Red Dragon"
// sheet (CC-BY 3.0 — see public/assets/dragon/LICENSE.txt) and draws crisp,
// pre-scaled frames of its gentle flight loop. While the sheet is loading (or if
// it failed) callers keep drawing the programmatic dragon instead.

export const DRAGON_SHEET_FILE = 'assets/dragon/reddragonfly3.png';
/** 4x4 grid of cells; the dragon faces left (west). */
export const DRAGON_CELL = { w: 205, h: 161 } as const;

interface DragonFrame {
  row: number;
  col: number;
}

// Rows 0-1: the 8-frame flight loop (wings high → low → high).
const FLY: DragonFrame[] = [
  { row: 0, col: 0 },
  { row: 0, col: 1 },
  { row: 0, col: 2 },
  { row: 0, col: 3 },
  { row: 1, col: 0 },
  { row: 1, col: 1 },
  { row: 1, col: 2 },
  { row: 1, col: 3 },
];
const FLY_FPS = 8;

let sheet: HTMLImageElement | null = null;
let ready = false;
let failed = false;

function ensureSheet(): void {
  if (sheet || typeof Image === 'undefined') return;
  sheet = new Image();
  sheet.decoding = 'async';
  sheet.onload = () => {
    ready = true;
  };
  sheet.onerror = () => {
    failed = true;
  };
  // BASE_URL is '/' in dev and './' in the desktop build (dist loaded from file://).
  sheet.src = `${import.meta.env.BASE_URL}${DRAGON_SHEET_FILE}`;
}

/** True once the sheet can be drawn; also kicks off loading on first call. */
export function dragonSheetReady(): boolean {
  ensureSheet();
  return ready && !failed;
}

const cache = new Map<string, HTMLCanvasElement>();

/** One cell, pre-scaled with nearest-neighbour sampling. */
function frameCanvas(f: DragonFrame, scale: number): HTMLCanvasElement | null {
  if (!ready || !sheet) return null;
  const key = `${f.row}:${f.col}:${scale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = Math.max(1, Math.round(DRAGON_CELL.w * scale));
  const h = Math.max(1, Math.round(DRAGON_CELL.h * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  if (!c) return null;
  c.imageSmoothingEnabled = false;
  c.drawImage(sheet, f.col * DRAGON_CELL.w, f.row * DRAGON_CELL.h, DRAGON_CELL.w, DRAGON_CELL.h, 0, 0, w, h);
  cache.set(key, cv);
  return cv;
}

/** Draws the flight loop at time `t` with the cell's top-left at (x, y). Returns the frame index, or null while loading. */
export function drawDragonFrame(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, scale: number): number | null {
  ensureSheet();
  const index = ((Math.floor(t * FLY_FPS) % FLY.length) + FLY.length) % FLY.length;
  const frame = FLY[index] ?? { row: 0, col: 0 };
  const cv = frameCanvas(frame, scale);
  if (!cv) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, Math.round(x), Math.round(y));
  return index;
}
