// Hero swords from the public-domain openclipart pack
// (client/public/assets/weapons/ocal-swords/, see its LICENSE.txt). Every
// 32x32 sword lies diagonally (pommel bottom-left, tip top-right); we grip it
// near the pommel and rotate it to the blade angle of the current LPC frame.

export type WeaponId =
  | 'long_sword_01'
  | 'medieval_sword_01'
  | 'gladius_01'
  | 'gladius_02'
  | 'scimitar_01'
  | 'scimitar_02'
  | 'tanto_01'
  | 'heavy_sword_01'
  | 'muramasa_01';

const DIR = 'assets/weapons/ocal-swords/32x32/';

/** Pommel and tip pixels per sword (measured from the 32x32 files). */
const GEOM: Record<WeaponId, { p: [number, number]; t: [number, number] }> = {
  long_sword_01: { p: [0, 30], t: [31, 0] },
  medieval_sword_01: { p: [0, 30], t: [31, 0] },
  gladius_01: { p: [1, 29], t: [30, 1] },
  gladius_02: { p: [0, 30], t: [31, 0] },
  scimitar_01: { p: [6, 28], t: [25, 2] },
  scimitar_02: { p: [0, 29], t: [30, 0] },
  tanto_01: { p: [4, 25], t: [28, 4] },
  heavy_sword_01: { p: [0, 30], t: [31, 0] },
  muramasa_01: { p: [0, 30], t: [31, 0] },
};

export const WEAPON_IDS = Object.keys(GEOM) as WeaponId[];
const SQUIRE_WEAPONS: WeaponId[] = ['tanto_01', 'gladius_01', 'gladius_02'];

/** World px per sword px at hero scale 1: a full-length blade comes out ~15 px. */
const WEAPON_SCALE = 0.36;

/** Stable sword for a hero hash; squires carry a tanto or a gladius. */
export function weaponFor(hash: number, squire: boolean): WeaponId {
  const list = squire ? SQUIRE_WEAPONS : WEAPON_IDS;
  return list[(hash >>> 7) % list.length] as WeaponId;
}

type LoadState = 'loading' | 'ok' | 'err';
const imgs = new Map<WeaponId, { img: HTMLImageElement; state: LoadState }>();

function weaponImage(id: WeaponId): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let e = imgs.get(id);
  if (!e) {
    const img = new Image();
    img.decoding = 'async';
    const entry = { img, state: 'loading' as LoadState };
    img.onload = () => {
      entry.state = 'ok';
    };
    img.onerror = () => {
      entry.state = 'err';
    };
    img.src = `${import.meta.env.BASE_URL}${DIR}${id}.png`;
    imgs.set(id, entry);
    e = entry;
  }
  return e.state === 'ok' ? e.img : null;
}

/**
 * Draws `id` gripped at (hx, hy) with the blade pointing along `angleDeg`
 * (screen degrees: 0 = right, 90 = down). Returns false while the image loads.
 */
export function drawWeapon(ctx: CanvasRenderingContext2D, id: WeaponId, hx: number, hy: number, angleDeg: number, scale = 1): boolean {
  const img = weaponImage(id);
  if (!img) return false;
  const { p, t } = GEOM[id];
  const base = Math.atan2(t[1] - p[1], t[0] - p[0]);
  // grip a little up the handle from the pommel
  const gx = p[0] + (t[0] - p[0]) * 0.14;
  const gy = p[1] + (t[1] - p[1]) * 0.14;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate((angleDeg * Math.PI) / 180 - base);
  ctx.scale(WEAPON_SCALE * scale, WEAPON_SCALE * scale);
  // smoothed: at 0.36x a nearest-neighbour rotation drops most of the 1 px blade
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -gx, -gy);
  ctx.restore();
  return true;
}
