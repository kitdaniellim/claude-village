// LPC hero sprites: composites wulax's layered "Medieval fantasy character"
// sheets (client/public/assets/characters/lpc/, CC-BY-SA 3.0) into one 0.5x
// sheet per look + animation and draws single frames. Every layer is a
// 64 px grid with one row per facing (up, left, down, right; hurt has one
// row). Callers keep the programmatic hero until a look's walk sheet exists.

export const LPC_DIR = 'assets/characters/lpc/png/';
export const LPC_CELL = 64;
export const LPC_SCALE = 0.5;
/** Frame cell as drawn. */
export const HERO_CELL = LPC_CELL * LPC_SCALE;

export type LpcAnim = 'walk' | 'slash' | 'spellcast' | 'thrust' | 'shoot' | 'hurt';
export type Dir4 = 'up' | 'left' | 'down' | 'right';
export const DIR_ROW: Record<Dir4, number> = { up: 0, left: 1, down: 2, right: 3 };

interface AnimDef {
  folder: string;
  frames: number;
  body: string;
}

export const ANIMS: Record<LpcAnim, AnimDef> = {
  walk: { folder: 'walkcycle', frames: 9, body: 'BODY_male' },
  slash: { folder: 'slash', frames: 6, body: 'BODY_human' },
  spellcast: { folder: 'spellcast', frames: 7, body: 'BODY_male' },
  thrust: { folder: 'thrust', frames: 8, body: 'BODY_animation' },
  shoot: { folder: 'bow', frames: 13, body: 'BODY_animation' },
  hurt: { folder: 'hurt', frames: 6, body: 'BODY_male' },
};

/** Layers the pack does not ship for some animations (never requested, so no 404s). */
const NOT_IN: Record<string, LpcAnim[]> = { BEHIND_quiver: ['shoot'] };

/** A look: clothing layers bottom → top (README order) plus the weapon per action animation. */
/** Visible gear, so the party portrait matches the sprite (utils/portraits.ts deals faces per class). */
export type LookGear = 'armored' | 'hooded' | 'plain';

export interface LpcLook {
  name: string;
  /** armored = plate / chain / helm; hooded = robe cowl; plain = everyday clothes and hats. */
  gear: LookGear;
  layers: string[];
  weapons: Partial<Record<LpcAnim, string[]>>;
}

const BOW = ['WEAPON_bow', 'WEAPON_arrow'];
// slash / thrust draw the hero's OCAL sword at the hand instead of the pack's dagger / spear / staff
const melee = (_thrust: string): LpcLook['weapons'] => ({ shoot: BOW });

export const LOOKS: LpcLook[] = [
  { name: 'knight', gear: 'armored', layers: ['FEET_plate_armor_shoes', 'LEGS_plate_armor_pants', 'TORSO_plate_armor_torso', 'TORSO_plate_armor_arms_shoulders', 'HEAD_plate_armor_helmet', 'HANDS_plate_armor_gloves'], weapons: melee('WEAPON_spear') },
  { name: 'ranger', gear: 'plain', layers: ['BEHIND_quiver', 'FEET_shoes_brown', 'LEGS_pants_greenish', 'TORSO_leather_armor_shirt_white', 'TORSO_leather_armor_torso', 'TORSO_leather_armor_shoulders', 'TORSO_leather_armor_bracers', 'BELT_leather', 'HEAD_leather_armor_hat'], weapons: melee('WEAPON_spear') },
  { name: 'monk', gear: 'hooded', layers: ['FEET_shoes_brown', 'LEGS_robe_skirt', 'TORSO_robe_shirt_brown', 'BELT_rope', 'HEAD_robe_hood'], weapons: melee('WEAPON_staff') },
  { name: 'chainmail', gear: 'armored', layers: ['FEET_shoes_brown', 'LEGS_pants_greenish', 'TORSO_chain_armor_torso', 'TORSO_chain_armor_jacket_purple', 'BELT_leather', 'HEAD_chain_armor_helmet'], weapons: melee('WEAPON_spear') },
  { name: 'hooded', gear: 'armored', layers: ['FEET_shoes_brown', 'LEGS_pants_greenish', 'TORSO_chain_armor_torso', 'BELT_leather', 'HEAD_chain_armor_hood'], weapons: melee('WEAPON_staff') },
  { name: 'villager', gear: 'plain', layers: ['FEET_shoes_brown', 'LEGS_pants_greenish', 'TORSO_leather_armor_shirt_white', 'BELT_leather', 'HEAD_hair_blonde'], weapons: melee('WEAPON_staff') },
  { name: 'mixed-metal', gear: 'armored', layers: ['FEET_plate_armor_shoes', 'LEGS_plate_armor_pants', 'TORSO_chain_armor_torso', 'TORSO_plate_armor_arms_shoulders', 'HANDS_plate_armor_gloves', 'HEAD_chain_armor_hood'], weapons: melee('WEAPON_spear') },
  { name: 'bandit', gear: 'hooded', layers: ['FEET_shoes_brown', 'LEGS_pants_greenish', 'TORSO_chain_armor_jacket_purple', 'BELT_rope', 'HEAD_robe_hood'], weapons: melee('WEAPON_staff') },
  { name: 'pilgrim', gear: 'plain', layers: ['FEET_shoes_brown', 'LEGS_robe_skirt', 'TORSO_leather_armor_shirt_white', 'TORSO_leather_armor_torso', 'BELT_rope', 'HEAD_hair_blonde'], weapons: melee('WEAPON_staff') },
  // guard: leather only (it used to mix plate shoulders / shoes under a leather hat, which no portrait matched)
  { name: 'guard', gear: 'plain', layers: ['FEET_shoes_brown', 'LEGS_pants_greenish', 'TORSO_leather_armor_shirt_white', 'TORSO_leather_armor_torso', 'TORSO_leather_armor_shoulders', 'BELT_leather', 'HEAD_leather_armor_hat'], weapons: melee('WEAPON_spear') },
];

/** Stable look for a session (same hash family as the tunic colours). */
export function lookFor(hash: number): number {
  return (hash >>> 3) % LOOKS.length;
}

/** Every squire wears the plain villager look (bare head, white shirt). */
export const SQUIRE_LOOK = Math.max(0, LOOKS.findIndex((l) => l.name === 'villager'));
/** Squires draw at 0.85x of a hero. */
export const SQUIRE_SCALE = 0.85;

type LoadState = 'loading' | 'ok' | 'err';
const images = new Map<string, { img: HTMLImageElement; state: LoadState }>();
const sheets = new Map<string, HTMLCanvasElement>();

/** Drawn cell size for a sprite scale (whole pixels so frames blit 1:1). */
function cellFor(scale: number): number {
  return Math.max(8, Math.round(HERO_CELL * scale));
}

function layerImage(folder: string, layer: string): { img: HTMLImageElement; state: LoadState } | null {
  if (typeof Image === 'undefined') return null;
  const url = `${import.meta.env.BASE_URL}${LPC_DIR}${folder}/${layer}.png`;
  const hit = images.get(url);
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
  img.src = url;
  images.set(url, entry);
  return entry;
}

function layersFor(look: LpcLook, anim: LpcAnim): string[] {
  const def = ANIMS[anim];
  const out = [def.body];
  for (const l of look.layers) if (!NOT_IN[l]?.includes(anim)) out.push(l);
  // BEHIND sits under the body
  out.sort((a, b) => (a.startsWith('BEHIND') ? -1 : 0) - (b.startsWith('BEHIND') ? -1 : 0));
  return [...out, ...(look.weapons[anim] ?? [])];
}

/**
 * The composited sheet for a look + animation at `scale` (0.5x of the pack
 * by default; cols = frames, rows = facings), or null while any layer is
 * still loading. Layers that fail to load are skipped so one bad file never
 * blanks a hero.
 */
export function lpcSheet(lookIdx: number, anim: LpcAnim, scale = 1): HTMLCanvasElement | null {
  const cell = cellFor(scale);
  const key = `${lookIdx}:${anim}:${cell}`;
  const done = sheets.get(key);
  if (done) return done;
  const look = LOOKS[lookIdx];
  if (!look) return null;
  const def = ANIMS[anim];
  const entries = layersFor(look, anim).map((l) => layerImage(def.folder, l));
  if (entries.some((e) => e === null || e.state === 'loading')) return null;
  const rows = anim === 'hurt' ? 1 : 4;
  const full = document.createElement('canvas');
  full.width = def.frames * LPC_CELL;
  full.height = rows * LPC_CELL;
  const fc = full.getContext('2d');
  if (!fc) return null;
  for (const e of entries) if (e && e.state === 'ok') fc.drawImage(e.img, 0, 0);
  // one box-filtered reduction keeps the outlines; frames are then blitted 1:1
  const cv = document.createElement('canvas');
  cv.width = def.frames * cell;
  cv.height = rows * cell;
  const c = cv.getContext('2d');
  if (!c) return null;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(full, 0, 0, cv.width, cv.height);
  sheets.set(key, cv);
  return cv;
}

/** Starts loading every animation of a look (idempotent). */
export function preloadLook(lookIdx: number, scale = 1): void {
  for (const anim of Object.keys(ANIMS) as LpcAnim[]) lpcSheet(lookIdx, anim, scale);
}

export function lpcLookReady(lookIdx: number, scale = 1): boolean {
  return lpcSheet(lookIdx, 'walk', scale) !== null;
}

/** Feet sit on cell row 62 of 64; the head top is around row 15 (hats reach 6). */
const FEET_ROW = 62;
const HEAD_ROW = 15;

/**
 * Draws one frame with the feet centred at (x, y). Falls back to the walk
 * sheet's standing frame if the animation is not composited yet. Returns the
 * sprite's top y for bubbles/labels, or null when nothing could be drawn.
 */
export function drawLpcHero(ctx: CanvasRenderingContext2D, lookIdx: number, anim: LpcAnim, dir: Dir4, frame: number, x: number, y: number, scale = 1): number | null {
  let sheet = lpcSheet(lookIdx, anim, scale);
  let a = anim;
  let f = frame;
  if (!sheet) {
    sheet = lpcSheet(lookIdx, 'walk', scale);
    a = 'walk';
    f = 0;
  }
  if (!sheet) return null;
  const cell = cellFor(scale);
  const k = cell / LPC_CELL;
  const col = Math.max(0, Math.min(ANIMS[a].frames - 1, Math.floor(f)));
  const row = a === 'hurt' ? 0 : DIR_ROW[dir];
  const dx = Math.round(x) - Math.floor(cell / 2);
  const dy = Math.round(y) - Math.round(FEET_ROW * k);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, col * cell, row * cell, cell, cell, dx, dy, cell, cell);
  return dy + Math.round(HEAD_ROW * k);
}

/** Weapon hand (x, y in the 64 px cell) + blade angle (deg, 0 = right, 90 = down) per anim / facing row (up, left, down, right) / frame.
 *  Hands come from the pack's glove layer; slash / thrust angles follow a designed swing arc. */
const HAND: Partial<Record<LpcAnim, Array<Array<[number, number, number]>>>> = {
  walk: [
    [[43, 46, 105], [43, 46, 105], [43, 44, 105], [43, 43, 105], [43, 44, 105], [43, 46, 105], [43, 47, 105], [43, 48, 105], [43, 47, 105]], // up
    [[24, 46, 120], [33, 48, 120], [35, 48, 120], [41, 48, 120], [24, 47, 120], [22, 47, 120], [25, 48, 120], [39, 48, 120], [37, 48, 120]], // left
    [[43, 46, 75], [43, 46, 75], [43, 44, 75], [43, 45, 75], [43, 44, 75], [43, 46, 75], [43, 47, 75], [42, 49, 75], [43, 47, 75]], // down
    [[39, 46, 60], [30, 48, 60], [28, 48, 60], [22, 48, 60], [39, 47, 60], [41, 47, 60], [38, 48, 60], [24, 48, 60], [26, 48, 60]], // right
  ],
  slash: [
    [[43, 47, 105], [22, 48, 150], [24, 48, -150], [22, 47, -100], [50, 31, -70], [53, 36, -40]], // up
    [[24, 46, 120], [20, 48, 80], [23, 46, 30], [14, 44, -100], [11, 33, -160], [14, 32, 150]], // left
    [[43, 46, 75], [37, 46, 110], [29, 47, 150], [40, 46, -110], [51, 43, -40], [54, 40, 60]], // down
    [[39, 46, 60], [43, 48, 100], [40, 46, 150], [48, 44, -80], [52, 33, -20], [49, 32, 30]], // right
  ],
  thrust: [
    [[20, 47, 105], [22, 46, -90], [41, 51, -90], [41, 51, -90], [41, 51, -90], [41, 51, -90], [41, 51, -90], [41, 51, -90]], // up
    [[24, 46, -160], [22, 46, 179], [22, 45, 179], [25, 43, 179], [18, 44, 179], [16, 44, 179], [18, 44, 179], [25, 43, 179]], // left
    [[43, 46, 75], [35, 46, 60], [27, 45, 70], [26, 42, 90], [28, 44, 90], [29, 47, 90], [28, 44, 90], [25, 41, 90]], // down
    [[39, 46, -20], [41, 46, 1], [41, 45, 1], [38, 43, 1], [44, 44, 1], [48, 44, 1], [44, 44, 1], [38, 43, 1]], // right
  ],
  spellcast: [
    [[43, 47, 105], [43, 47, 105], [43, 47, 105], [47, 41, -90], [53, 35, -90], [52, 28, -90], [47, 41, -90]], // up
    [[24, 46, 120], [23, 45, 120], [28, 44, 120], [22, 41, -90], [20, 37, -90], [21, 29, -90], [22, 41, -90]], // left
    [[43, 46, 75], [43, 44, 75], [35, 43, 75], [46, 42, -90], [53, 34, -90], [52, 27, -90], [45, 44, -90]], // down
    [[39, 46, 60], [40, 45, 60], [35, 44, 60], [41, 41, -90], [43, 37, -90], [42, 29, -90], [41, 41, -90]], // right
  ],
};

export interface HandPose {
  /** Grip point in world px. */
  x: number;
  y: number;
  /** Blade direction in screen degrees. */
  angle: number;
}

/** Where the weapon hand of a frame drawn by drawLpcHero(…, x, y, scale) is, or null for anims without a hand row. */
export function lpcHand(anim: LpcAnim, dir: Dir4, frame: number, x: number, y: number, scale = 1): HandPose | null {
  const rows = HAND[anim];
  if (!rows) return null;
  const row = rows[DIR_ROW[dir]];
  const v = row?.[Math.max(0, Math.min(row.length - 1, Math.floor(frame)))];
  if (!v) return null;
  const cell = cellFor(scale);
  const k = cell / LPC_CELL;
  const dx = Math.round(x) - Math.floor(cell / 2);
  const dy = Math.round(y) - Math.round(FEET_ROW * k);
  return { x: dx + v[0] * k, y: dy + v[1] * k, angle: v[2] };
}
