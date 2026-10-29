// Low-level pixel-art drawing helpers shared by the world renderer: matrix
// sprites, discs/ellipses, outlined text, rings and a tiny seeded RNG.

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** mulberry32 — small, fast, deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash (same as spriteMapper/registry). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 0xff) * factor)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Render a character matrix to an offscreen canvas ('.' and unknown chars are transparent). */
export function renderMatrix(rows: string[], palette: Record<string, string>, scale: number): HTMLCanvasElement {
  const wChars = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, wChars * scale);
  cv.height = Math.max(1, rows.length * scale);
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.imageSmoothingEnabled = false;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[row.charAt(x)];
      if (color === undefined) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  });
  return cv;
}

/** Draw a character matrix straight onto a context (no caching). */
export function drawMatrix(
  ctx: CanvasRenderingContext2D,
  rows: string[],
  palette: Record<string, string>,
  x: number,
  y: number,
  scale = 1,
  flipX = false,
): void {
  const wChars = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const color = palette[row.charAt(rx)];
      if (color === undefined) continue;
      ctx.fillStyle = color;
      const px = flipX ? wChars - 1 - rx : rx;
      ctx.fillRect(x + px * scale, y + ry * scale, scale, scale);
    }
  });
}

/** Rects (in sprite px) for every char of `chars` in a matrix — used for window glow. */
export function matrixRects(rows: string[], chars: string, scale: number): Rect[] {
  const out: Rect[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row.charAt(x);
      if (ch !== '.' && chars.includes(ch)) out.push({ x: x * scale, y: y * scale, w: scale, h: scale });
    }
  });
  return out;
}

export function drawPixelDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(Math.max(0, r * r - y * y)));
    ctx.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1);
  }
}

export function drawPixelEllipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
): void {
  ctx.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const k = 1 - (y * y) / Math.max(1, ry * ry);
    if (k < 0) continue;
    const half = Math.floor(Math.sqrt(k) * rx);
    ctx.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1);
  }
}

export function drawPixelRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, squash = 0.75): void {
  ctx.fillStyle = color;
  const steps = Math.max(16, Math.floor(r * 5));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ctx.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * squash), 1, 1);
  }
}

export function drawRectOutline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, t = 2): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, t);
  ctx.fillRect(x, y + h - t, w, t);
  ctx.fillRect(x, y, t, h);
  ctx.fillRect(x + w - t, y, t, h);
}

const OUTLINE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function drawTextOutlined(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fill: string,
  font: string,
  outline = '#1a1410',
  align: CanvasTextAlign = 'center',
): void {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillStyle = outline;
  for (const [dx, dy] of OUTLINE_OFFSETS) ctx.fillText(text, x + dx, y + dy);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** Parchment notice (empty states). */
export function drawParchment(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  title: string,
  sub: string | null,
  big: boolean,
): void {
  const titleFont = big ? 'bold 15px monospace' : 'bold 12px monospace';
  const subFont = big ? '11px monospace' : '10px monospace';
  ctx.font = titleFont;
  const tw = ctx.measureText(title).width;
  ctx.font = subFont;
  const sw = sub ? ctx.measureText(sub).width : 0;
  const w = Math.ceil(Math.max(tw, sw)) + (big ? 48 : 32);
  const h = (sub ? (big ? 58 : 48) : big ? 40 : 32) | 0;
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + 3, y + 4, w, h);
  ctx.fillStyle = '#5d4524';
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = '#e9d8a6';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#c9b176';
  ctx.fillRect(x + 2, y + 2, w - 4, 2);
  ctx.fillRect(x + 2, y + h - 4, w - 4, 2);
  ctx.fillStyle = '#5d4524';
  ctx.fillRect(x, y, 2, 2);
  ctx.fillRect(x + w - 2, y, 2, 2);
  ctx.fillRect(x, y + h - 2, 2, 2);
  ctx.fillRect(x + w - 2, y + h - 2, 2, 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = titleFont;
  ctx.fillStyle = '#4a3318';
  ctx.fillText(title, cx, y + (big ? 9 : 7));
  if (sub) {
    ctx.font = subFont;
    ctx.fillStyle = '#6e542e';
    ctx.fillText(sub, cx, y + (big ? 30 : 24));
  }
}

/** Hanging cloth banner with a title (city names) — drawn in screen space. */
export function drawBanner(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  text: string,
  cloth: string,
  trim: string,
  font: string,
): void {
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + 22;
  const h = 16;
  const x = Math.round(cx - w / 2);
  const yy = Math.round(y);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + 2, yy + 3, w, h);
  // rod
  ctx.fillStyle = '#5d4524';
  ctx.fillRect(x - 4, yy - 2, w + 8, 2);
  ctx.fillRect(x - 5, yy - 3, 2, 4);
  ctx.fillRect(x + w + 3, yy - 3, 2, 4);
  // cloth with swallow-tail bottom
  ctx.fillStyle = cloth;
  ctx.fillRect(x, yy, w, h);
  ctx.fillStyle = trim;
  ctx.fillRect(x, yy, w, 1);
  ctx.fillRect(x, yy + h - 2, w, 1);
  ctx.fillRect(x, yy, 1, h);
  ctx.fillRect(x + w - 1, yy, 1, h);
  ctx.fillStyle = cloth;
  ctx.fillRect(x + 3, yy + h, w - 6, 2);
  ctx.fillRect(x + 6, yy + h + 2, w - 12, 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#1a1410';
  ctx.fillText(text, cx + 1, yy + 4);
  ctx.fillStyle = '#f6ead0';
  ctx.fillText(text, cx, yy + 3);
}

/** Small wooden name plate (building names) — drawn in screen space. */
export function drawPlate(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string, font: string, hot = false): void {
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + 10;
  const h = 12;
  const x = Math.round(cx - w / 2);
  const yy = Math.round(y);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x + 1, yy + 2, w, h);
  ctx.fillStyle = hot ? '#8a6a2a' : '#4b3a22';
  ctx.fillRect(x - 1, yy - 1, w + 2, h + 2);
  ctx.fillStyle = hot ? '#e2c27a' : '#b58a4c';
  ctx.fillRect(x, yy, w, h);
  ctx.fillStyle = hot ? '#f1dc9f' : '#c99d5e';
  ctx.fillRect(x, yy, w, 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#2b1d0e';
  ctx.fillText(text, cx, yy + 2);
}
