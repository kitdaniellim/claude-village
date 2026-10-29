// Monster sprite sheets. Goblin + ogre prefer the user-supplied preview art
// (client/public/assets/monsters/user-preview/, licence unknown — see its
// LICENSE.txt) and fall back to Calciumtrice's CC-BY 3.0 goblin / orc if
// those fail to load; the eyeball is always Calciumtrice. Frames are cut
// from uniform cells, pre-flipped / white-flashed into cached canvases and
// drawn at a per-sheet scale. While no sheet is ready callers draw the
// programmatic stand-in instead.

export type MonsterKind = 'bug' | 'goblin' | 'ogre';
export type MonsterAnim = 'idle' | 'move' | 'taunt' | 'attack' | 'death' | 'blink';

interface AnimRow {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  /** Column per step (repeats hold a pose); `frames` is then seq.length. */
  seq?: number[];
}

interface SheetDef {
  /** Folder under assets/monsters/ + file name. */
  path: string;
  cellW: number;
  cellH: number;
  /** World px per sheet px. */
  scale: number;
  /** True when the art faces right (flip to face left). The eyeball is symmetric; its tail hangs right. */
  facesRight: boolean;
  /** Cell row of the feet / head top, for anchoring and labels. */
  feetRow: number;
  headRow: number;
  /** Farthest opaque pixel of any attack frame toward the facing, from the feet centre (sheet px). */
  reach: number;
  anims: Partial<Record<MonsterAnim, AnimRow>>;
}

const row = (r: number, frames: number, fps: number, loop: boolean): AnimRow => ({ row: r, frames, fps, loop });
const seqRow = (r: number, seq: number[], fps: number, loop: boolean): AnimRow => ({ row: r, frames: seq.length, fps, loop, seq });

const CALC = 'assets/monsters/calciumtrice/';
const USER = 'assets/monsters/user-preview/';

// Calciumtrice sheets: 32 px cells drawn 1:1.
const calc = (file: string, facesRight: boolean, feetRow: number, headRow: number, reach: number, anims: SheetDef['anims']): SheetDef => ({ path: CALC + file, cellW: 32, cellH: 32, scale: 1, facesRight, feetRow, headRow, reach, anims });
const calcFive: SheetDef['anims'] = { idle: row(0, 10, 8, true), taunt: row(1, 10, 8, false), move: row(2, 10, 12, true), attack: row(3, 10, 12, false), death: row(4, 10, 16, false) };

/** Preferred sheet first; later entries load only if the earlier ones fail. */
export const MONSTER_SHEETS: Record<MonsterKind, SheetDef[]> = {
  // eyeball spritesheet.png — 8x3: hover, dash, blink
  bug: [calc('eyeball.png', false, 26, 7, 10, { idle: row(0, 8, 8, true), move: row(1, 8, 12, true), blink: row(2, 8, 10, false) })],
  goblin: [
    // user-preview goblin.png — 36x34 cells: run (2), attack (2), idle (2); no death row. 0.7x keeps it smaller than a hero.
    {
      path: USER + 'goblin.png',
      cellW: 36,
      cellH: 34,
      scale: 0.7,
      facesRight: false,
      feetRow: 34,
      headRow: 4,
      reach: 16, // sword smear (measured from the attack row)
      anims: { idle: seqRow(2, [0, 1], 2.5, true), move: seqRow(0, [0, 1], 8, true), taunt: seqRow(1, [0, 0, 0, 1, 1, 1], 10, false), attack: seqRow(1, [0, 0, 0, 1, 1, 1], 10, false) },
    },
    // goblin spritesheet calciumtrice.png — rows 0-4 are the little knife goblin
    calc('goblin.png', true, 32, 14, 11, calcFive),
  ],
  ogre: [
    // user-preview ogre.png — 64x39 cells: idle (3), club swing (3), walk (3); no death row. 1.2x ≈ 1.6x hero height.
    {
      path: USER + 'ogre.png',
      cellW: 64,
      cellH: 39,
      scale: 1.2,
      facesRight: false,
      feetRow: 39,
      headRow: 7,
      reach: 30, // club smear (measured from the attack row)
      anims: { idle: seqRow(0, [0, 1, 2, 1], 3, true), move: seqRow(2, [0, 1, 2, 1], 6, true), taunt: seqRow(1, [0, 0, 0, 1, 2, 2, 2, 2], 10, false), attack: seqRow(1, [0, 0, 0, 1, 2, 2, 2, 2], 10, false) },
    },
    // orc spritesheet calciumtrice.png — rows 0-4 are the spear orc
    calc('orc.png', true, 32, 0, 16, calcFive),
  ],
};

type LoadState = 'loading' | 'ok' | 'err';
const sheets = new Map<string, { img: HTMLImageElement; state: LoadState }>();
const frames = new Map<string, HTMLCanvasElement>();

function load(def: SheetDef): { img: HTMLImageElement; state: LoadState } | null {
  if (typeof Image === 'undefined') return null;
  const hit = sheets.get(def.path);
  if (hit) return hit;
  const img = new Image();
  img.decoding = 'async';
  const entry = { img, state: 'loading' as LoadState };
  img.onload = () => {
    entry.state = 'ok';
  };
  img.onerror = () => {
    entry.state = 'err';
  };
  // BASE_URL is '/' in dev and './' in the desktop build (dist loaded from file://).
  img.src = `${import.meta.env.BASE_URL}${def.path}`;
  sheets.set(def.path, entry);
  return entry;
}

/** First loaded sheet in preference order; waits (null) while an earlier one is still loading. */
function activeSheet(kind: MonsterKind): { def: SheetDef; img: HTMLImageElement } | null {
  for (const def of MONSTER_SHEETS[kind]) {
    const s = load(def);
    if (!s || s.state === 'loading') return null;
    if (s.state === 'ok') return { def, img: s.img };
  }
  return null;
}

/** Sheet whose timings apply: the active one, else the first not known to have failed. */
function timingDef(kind: MonsterKind): SheetDef {
  const a = activeSheet(kind);
  if (a) return a.def;
  const defs = MONSTER_SHEETS[kind];
  return defs.find((d) => sheets.get(d.path)?.state !== 'err') ?? (defs[0] as SheetDef);
}

/** True once the kind's sheet can be drawn; also kicks off loading on first call. */
export function monsterSheetReady(kind: MonsterKind): boolean {
  return activeSheet(kind) !== null;
}

/** Starts loading every monster sheet (idempotent; fallbacks load only after a failure). */
export function preloadMonsters(): void {
  for (const k of Object.keys(MONSTER_SHEETS) as MonsterKind[]) activeSheet(k);
}

/** Step index for an animation at local time `t` (seconds since it started). */
export function monsterFrameIndex(kind: MonsterKind, anim: MonsterAnim, t: number): number {
  const def = timingDef(kind);
  const a = def.anims[anim] ?? def.anims.idle;
  if (!a) return 0;
  const i = Math.floor(Math.max(0, t) * a.fps);
  return a.loop ? i % a.frames : Math.min(a.frames - 1, i);
}

/** Seconds a one-shot animation takes to play through. */
export function monsterAnimDuration(kind: MonsterKind, anim: MonsterAnim): number {
  const a = timingDef(kind).anims[anim];
  return a ? a.frames / a.fps : 0;
}

export function monsterHasAnim(kind: MonsterKind, anim: MonsterAnim): boolean {
  return timingDef(kind).anims[anim] !== undefined;
}

/** How far the attack frames reach toward the foe from the feet centre, in world px. */
export function monsterReach(kind: MonsterKind): number {
  const def = activeSheet(kind)?.def ?? timingDef(kind);
  return def.reach * def.scale;
}

/** Drawn height (feet to head top) of the active sheet in world px, or null while none is ready. */
export function monsterSpriteHeight(kind: MonsterKind): number | null {
  const a = activeSheet(kind);
  return a ? (a.def.feetRow - a.def.headRow) * a.def.scale : null;
}

/** One cell, mirrored if asked and optionally flattened to white (hit flash), cached. */
function frameCanvas(def: SheetDef, img: HTMLImageElement, r: number, col: number, flip: boolean, flash: boolean): HTMLCanvasElement | null {
  const key = `${def.path}:${r}:${col}:${flip ? 1 : 0}:${flash ? 1 : 0}`;
  const hit = frames.get(key);
  if (hit) return hit;
  // Shrinking sheets (scale < 1) are reduced once here with a box filter to whole pixels, like the 0.5x LPC
  // heroes; a nearest-neighbour shrink at draw time drops every other art pixel and the sprite breaks up.
  const shrink = def.scale < 1;
  const w = shrink ? Math.max(1, Math.round(def.cellW * def.scale)) : def.cellW;
  const h = shrink ? Math.max(1, Math.round(def.cellH * def.scale)) : def.cellH;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  if (!c) return null;
  c.imageSmoothingEnabled = shrink;
  c.imageSmoothingQuality = 'high';
  if (flip) {
    c.translate(w, 0);
    c.scale(-1, 1);
  }
  c.drawImage(img, col * def.cellW, r * def.cellH, def.cellW, def.cellH, 0, 0, w, h);
  if (flash) {
    // Tint instead of a solid white silhouette: the monster stays readable mid-hit.
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(255, 255, 255, 0.55)';
    c.fillRect(0, 0, w, h);
  }
  frames.set(key, cv);
  return cv;
}

export interface DrawnMonsterFrame {
  index: number;
  /** Sprite top / bottom in world px. */
  top: number;
  bottom: number;
}

/**
 * Draws `anim` at local time `t` with the feet centred at (x, y); `faceLeft`
 * mirrors the art to look left. `frameOverride` is a step index. Returns null
 * while no sheet is ready.
 */
export function drawMonsterFrame(
  ctx: CanvasRenderingContext2D,
  kind: MonsterKind,
  anim: MonsterAnim,
  t: number,
  x: number,
  y: number,
  faceLeft: boolean,
  flash = false,
  frameOverride: number | null = null,
): DrawnMonsterFrame | null {
  const s = activeSheet(kind);
  if (!s) return null;
  const def = s.def;
  const a = def.anims[anim] ?? def.anims.idle;
  if (!a) return null;
  const index = Math.max(0, Math.min(a.frames - 1, frameOverride ?? monsterFrameIndex(kind, anim, t)));
  const col = a.seq ? (a.seq[index] ?? 0) : index;
  const flip = def.facesRight ? faceLeft : !faceLeft;
  const cv = frameCanvas(def, s.img, a.row, col, flip, flash);
  if (!cv) return null;
  // pre-shrunk frames blit 1:1 at whole-pixel positions; larger sheets scale up nearest-neighbour
  const w = def.scale < 1 ? cv.width : def.cellW * def.scale;
  const h = def.scale < 1 ? cv.height : def.cellH * def.scale;
  const dx = Math.round(x) - Math.round(w / 2);
  const dy = Math.round(y) - Math.round(def.feetRow * def.scale);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, dx, dy, w, h);
  return { index, top: dy + Math.round(def.headRow * def.scale), bottom: dy + Math.round(def.feetRow * def.scale) };
}
