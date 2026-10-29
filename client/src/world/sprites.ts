// Pixel-matrix sprite bank: hero body frames + hand props, category icons,
// the dragon's parts and the per-repo building templates (stone / timber).
// '.' = transparent. Building rows are all the same width (checked by tests).

import { renderMatrix, shade } from './pixel';
import { HERO_COLORS } from '../utils/spriteMapper';

// ── Hero ─────────────────────────────────────────────────────────────────────

export type HeroPose = 'idle' | 'walk1' | 'walk3' | 'stretch' | 'sip' | 'kneel' | 'raise' | 'hold';

const HEAD = [
  '................',
  '.....HHHHHH.....',
  '....HHHHHHHH....',
  '....HHHHHHHH....',
  '....hSSSSSSh....',
  '....SSESSESS....',
  '....SSSSSSSS....',
  '.....SssssS.....',
];

const BODY_IDLE = [
  '....TTTTTTTT....',
  '...tTTTTTTTTt...',
  '...tTTTTTTTTt...',
  '...STWWWWWWTS...',
  '....TTTTTTTT....',
  '....LLL..LLL....',
  '....LLL..LLL....',
  '....BBB..BBB....',
];

// Right arm swung forward, left leg forward (mirror gives the other half-step).
const BODY_WALK1 = [
  '....TTTTTTTT....',
  '...tTTTTTTTTtt..',
  '...tTTTTTTTTtS..',
  '...STWWWWWWT....',
  '....TTTTTTTT....',
  '...LLL....LLL...',
  '..LLL......LLL..',
  '..BBB......BBB..',
];

const BODY_STRETCH = [
  '..S.TTTTTTTT.S..',
  '..t.TTTTTTTT.t..',
  '..ttTTTTTTTTtt..',
  '....TWWWWWWT....',
  '....TTTTTTTT....',
  '....LLL..LLL....',
  '....LLL..LLL....',
  '....BBB..BBB....',
];

const BODY_SIP = [
  '....TTTTTTTT.MM.',
  '...tTTTTTTTTtMM.',
  '...tTTTTTTTTSS..',
  '...STWWWWWWTT...',
  '....TTTTTTTT....',
  '....LLL..LLL....',
  '....LLL..LLL....',
  '....BBB..BBB....',
];

// One arm raised (sword / banner / hammer up). Hand at (13, 8).
const BODY_RAISE = [
  '....TTTTTTTT.S..',
  '...tTTTTTTTTtt..',
  '...tTTTTTTTTt...',
  '...STWWWWWWTT...',
  '....TTTTTTTT....',
  '....LLL..LLL....',
  '....LLL..LLL....',
  '....BBB..BBB....',
];

// Both hands out front (book / spyglass / ladle). Hands at (12..13, 10).
const BODY_HOLD = [
  '....TTTTTTTT....',
  '...tTTTTTTTTtt..',
  '...tTTTTTTTTSS..',
  '...STWWWWWWT....',
  '....TTTTTTTT....',
  '....LLL..LLL....',
  '....LLL..LLL....',
  '....BBB..BBB....',
];

const KNEEL = [
  '................',
  '................',
  '.....HHHHHH.....',
  '....HHHHHHHH....',
  '....HHHHHHHH....',
  '....hSSSSSSh....',
  '....SSESSESS....',
  '....SSSSSSSS....',
  '.....SssssS.....',
  '....TTTTTTTT....',
  '...tTTTTTTTTt...',
  '...SSTTTTTTSS...',
  '...TTWWWWWWTT...',
  '....TTTTTTTT....',
  '....LLLLLLLL....',
  '....BBBLLLBBB...',
];

function mirror(rows: string[]): string[] {
  return rows.map((r) => r.split('').reverse().join(''));
}

const POSES: Record<HeroPose, string[]> = {
  idle: [...HEAD, ...BODY_IDLE],
  walk1: [...HEAD, ...BODY_WALK1],
  walk3: [...HEAD, ...mirror(BODY_WALK1)],
  stretch: [...HEAD, ...BODY_STRETCH],
  sip: [...HEAD, ...BODY_SIP],
  kneel: KNEEL,
  raise: [...HEAD, ...BODY_RAISE],
  hold: [...HEAD, ...BODY_HOLD],
};

function heroPalette(colorIdx: number): Record<string, string> {
  const tunic = HERO_COLORS[colorIdx] ?? '#d95763';
  return {
    H: '#b9c2cf',
    h: '#8c97a8',
    S: '#eab985',
    s: '#c8915c',
    E: '#23232e',
    T: tunic,
    t: shade(tunic, 0.72),
    W: '#7a4a26',
    L: '#3f3347',
    B: '#272030',
    M: '#c98a3a',
  };
}

const heroCache = new Map<string, HTMLCanvasElement>();

export function heroSprite(colorIdx: number, pose: HeroPose): HTMLCanvasElement {
  const key = `${colorIdx}:${pose}`;
  const hit = heroCache.get(key);
  if (hit) return hit;
  const cv = renderMatrix(POSES[pose], heroPalette(colorIdx), 1);
  heroCache.set(key, cv);
  return cv;
}

// ── Hand props (drawn facing right; mirrored with the hero) ─────────────────

export const PROP_PALETTE: Record<string, string> = {
  K: '#8d95a3', // iron
  k: '#5b626e',
  h: '#8a5a33', // wood
  B: '#dfe6ee', // blade
  b: '#9aa6b5',
  G: '#e0b040', // gold
  P: '#6e3f23', // book cover
  p: '#f4ead2', // page
  l: '#3b3b55', // ink
  S: '#eab985',
  F: '#d4493f', // flag
  Y: '#f2c14e',
  L: '#3b3b3b', // spyglass
  g: '#9fd8ff',
};

export const PROPS = {
  bookA: ['PPPPPPP', 'PpplPpp', 'PplpPlp', 'PpplPpp', 'PPPPPPP'],
  bookB: ['PPPPPPP', 'PlppPpl', 'PpppPpp', 'PplpPpl', 'PPPPPPP'],
  hammerUp: ['KKKK', 'KkkK', 'KKKK', '.hh.', '.hh.', '.hh.', '.hh.'],
  hammerDown: ['.......', 'hhhhKKK', '....KkK', '....KKK'],
  swordUp: ['.B.', '.B.', '.B.', '.B.', '.B.', '.B.', 'GGG', '.h.'],
  swordMid: ['......B', '.....B.', '....B..', '...B...', '..B....', 'GG.....', 'h......'],
  swordDown: ['hGBBBBBBb', '.G.......'],
  spyglass: ['LLLLKKKg', 'LLLLKKKg'],
  ladleA: ['..h', '..h', '.h.', '.h.', 'KK.'],
  ladleB: ['h..', 'h..', '.h.', '.h.', '.KK'],
  mug: ['MM.', 'MMM', 'MM.'],
} as const;

export type PropId = keyof typeof PROPS;

const propCache = new Map<string, HTMLCanvasElement>();

export function propSprite(id: PropId): HTMLCanvasElement {
  const hit = propCache.get(id);
  if (hit) return hit;
  const cv = renderMatrix([...PROPS[id]], { ...PROP_PALETTE, M: '#c98a3a' }, 1);
  propCache.set(id, cv);
  return cv;
}

// ── Category icons (7x7, shown in the bubble over a working hero) ───────────

export const ICON_PALETTE: Record<string, string> = {
  P: '#6e3f23', w: '#f4ead2', K: '#8d95a3', h: '#8a5a33', B: '#dfe6ee', G: '#e0b040',
  F: '#d4493f', E: '#3b3b55', p: '#9fd8ff', C: '#e9c46a', l: '#74d77b', g: '#b8c0da',
  d: '#2b2520', M: '#c98a3a', m: '#f4ead2',
};

export const ICONS: Record<string, string[]> = {
  library: ['PPPPPPP', 'PwwPwwP', 'PwwPwwP', 'PwwPwwP', 'PwwPwwP', 'PPPPPPP', '...P...'],
  forge: ['.KKKK..', '.KKKK..', '.KKKKh.', '....hh.', '...hh..', '..hh...', '.hh....'],
  arena: ['B.....B', '.B...B.', '..B.B..', '...B...', '..G.G..', '.h...h.', '.......'],
  castle: ['hFFFF..', 'hFFFFF.', 'hFFFFFF', 'hFFFF..', 'h......', 'h......', 'h......'],
  watchtower: ['..EEE..', '.E...E.', 'E..p..E', 'E.ppp.E', 'E..p..E', '.E...E.', '..EEE..'],
  chapel: ['...C...', '..CCC..', 'CCCCCCC', '..CCC..', '..CCC..', '..CCC..', '..CCC..'],
  alchemist: ['..gg...', '..gg...', '.gllg..', 'gllllg.', 'gllllg.', 'gllllg.', '.gggg..'],
  tavern: ['MMMM...', 'MmmMM..', 'MmmMMM.', 'MmmMMM.', 'MmmMM..', 'MMMM...', '.......'],
  thinking: ['.......', '.......', '.......', 'd.d.d..', '.......', '.......', '.......'],
};

const iconCache = new Map<string, HTMLCanvasElement>();

export function iconSprite(id: string): HTMLCanvasElement {
  const hit = iconCache.get(id);
  if (hit) return hit;
  const rows = ICONS[id] ?? ICONS['alchemist'] ?? [];
  const cv = renderMatrix(rows, ICON_PALETTE, 1);
  iconCache.set(id, cv);
  return cv;
}

// ── Dragon (facing left, parts composed per frame at scale 2) ────────────────

export const DRAGON_PALETTE: Record<string, string> = {
  G: '#4f8a4a', g: '#3b6b38', d: '#c9c06a', H: '#e8dcb4', E: '#ffd23f', T: '#f4f0e6',
  W: '#7a3d6b', w: '#4f2846',
};

export const DRAGON = {
  headClosed: ['..HH....', '.GGGH...', 'GGEGG...', 'GGGGGG..', 'TGGGGGG.', '.GGGGGGG'],
  headOpen: ['..HH....', '.GGGH...', 'GGEGG...', 'GGGGGG..', 'TTGGGGG.', '....GGGG', 'TTTGGGGG'],
  body: [
    '..GGGGGG..........',
    '.dGGGGGHGGGHGGGHG.',
    'ddGGGGGGGGGGGGGGGG',
    'dddGGGGGGGGGGGGGGG',
    'ddddGGGGGGGGGGGGGg',
    '.ddddGGGGGGGGGGGGg',
    '..dddddGGGGGGGGGg.',
    '....GGG..GGG..GGG.',
    '....GgG..GgG..GgG.',
    '...GGGG.GGGG.GGGG.',
  ],
  wingFolded: ['.....ww.....', '....wWWw....', '...wWWWWw...', '..wWWWWWWw..', '.wWWWWWWWWw.', 'wWWWWWWWWWWw', 'WWWWWWWWWWWW'],
  wingSpread: [
    '......ww........',
    '....wwWWww......',
    '...wWWWWWWw.....',
    '..wWWWWWWWWw....',
    '.wWWWWWWWWWWw...',
    'wWWWWWWWWWWWWw..',
    '.WWWWWWWWWWWWWw.',
    '..WWWWWWWWWWWWWw',
    '....WWWWWWWWWW..',
  ],
} as const;

const dragonCache = new Map<string, HTMLCanvasElement>();
export const DRAGON_SCALE = 3;

export function dragonPart(id: keyof typeof DRAGON): HTMLCanvasElement {
  const hit = dragonCache.get(id);
  if (hit) return hit;
  const cv = renderMatrix([...DRAGON[id]], DRAGON_PALETTE, DRAGON_SCALE);
  dragonCache.set(id, cv);
  return cv;
}

/** Solid dark silhouette of a part — drawn at 1px offsets for a crisp outline. */
export function dragonSilhouette(id: keyof typeof DRAGON): HTMLCanvasElement {
  const key = `${id}:sil`;
  const hit = dragonCache.get(key);
  if (hit) return hit;
  const dark: Record<string, string> = {};
  for (const k of Object.keys(DRAGON_PALETTE)) dark[k] = '#17241a';
  const cv = renderMatrix([...DRAGON[id]], dark, DRAGON_SCALE);
  dragonCache.set(key, cv);
  return cv;
}

// ── Repo buildings ───────────────────────────────────────────────────────────

export interface BuildingTemplate {
  rows: string[];
  palette: Record<string, string>;
  /** chars recoloured when lit at night */
  lit: Record<string, string>;
  glowChars: string;
  /** door centre x (px at scale 2) */
  doorDx: number;
  /** chimney top (px at scale 2), if the building smokes */
  chimney: { x: number; y: number } | null;
}

const STONE_PALETTE: Record<string, string> = {
  R: '#3f4a5e', r: '#56657f', q: '#7083a0', S: '#9aa1ad', s: '#7d838e',
  G: '#5b5340', g: '#3d4f66', D: '#3f2c19', d: '#6e4f2e', P: '#6b4226', F: '#2e6fb5',
};
const STONE_LIT = { g: '#ffd97a' };

const TIMBER_PALETTE: Record<string, string> = {
  Y: '#c9a24a', y: '#a8842f', R: '#8a4a2b', r: '#a9623a', q: '#c57a48',
  t: '#5d3d22', w: '#e8d6ad', G: '#6b5634', g: '#3d4f66', D: '#4a2f1b', d: '#74552e',
  s: '#8f8a7e', A: '#d4493f', a: '#f1e4c8', b: '#8a5a33', m: '#e8b04f', f: '#d4493f',
};
const TIMBER_LIT = { g: '#ffd97a' };

export const STONE_TEMPLATES: BuildingTemplate[] = [
  {
    rows: [
      '...........RR...........',
      '..........RRRR..........',
      '.........RRrrRR.........',
      '........RRrrrrRR........',
      '.......RRrrqrrrRR.......',
      '......RRrrrrrrrrRR......',
      '.....RRrrqrrrqrrrRR.....',
      '....RRrrrrrrrrrrrrRR....',
      '...RRRRRRRRRRRRRRRRRR...',
      '...SSSSSSSSSSSSSSSSSS...',
      '...SSSGGGSSSSSSGGGSSS...',
      '...SsSGgGSsSSsSGgGSsS...',
      '...SSSGgGSSSSSSGgGSSS...',
      '...SSSGGGSSSSSSGGGSSS...',
      '...SsSSSSSSDDDDSSSSsS...',
      '...SSSSSSSDddddDSSSSS...',
      '...SsSSSsSDddddDSsSSS...',
      '...SSSSSSSDddddDSSSsS...',
      '...SSsSSSSDddddDSSSSS...',
      '..ssssssssDddddDssssss..',
    ],
    palette: STONE_PALETTE,
    lit: STONE_LIT,
    glowChars: 'g',
    doorDx: 25,
    chimney: { x: 34, y: 10 },
  },
  {
    rows: [
      '.....P..................',
      '.....PFFFF..............',
      '.....PFFF...............',
      '.....P..................',
      '..SS.SS.SS.SS.SS.SS.SS..',
      '..SSSSSSSSSSSSSSSSSSSS..',
      '..SsSSSSsSSSSSsSSSSsSS..',
      '..SSSSGgGSSSSSSGgGSSSS..',
      '..SSSSGgGSSSSSSGgGSSSS..',
      '..SSsSSSSSsSSSSSSsSSSS..',
      '..SSSSSSSSSSSSSSSSSSSS..',
      '..SSSSGgGSSSSSSGgGSSSS..',
      '..SsSSGgGSsSSSSGgGSSsS..',
      '..SSSSSSSSSSSSSSSSSSSS..',
      '..SSSSSSSSDDDDSSSSSSSS..',
      '..SSsSSSSDddddDSSSSsSS..',
      '..SSSSSSSDddddDSSSSSSS..',
      '..SsSSSSSDddddDSSsSSSS..',
      '..SSSSSSSDddddDSSSSSSS..',
      '.ssssssssDddddDssssssss.',
    ],
    palette: STONE_PALETTE,
    lit: STONE_LIT,
    glowChars: 'g',
    doorDx: 24,
    chimney: null,
  },
  {
    rows: [
      '...RRRR.................',
      '..RRrrRR................',
      '.RRrrqrRR...............',
      '.RRrrrrrRR..............',
      '.RRRRRRRRR..............',
      '.SSSSSSSSS...RRRRRRRRR..',
      '.SsSGgGSsS..RRrrqrrrrRR.',
      '.SSSGgGSSS.RRrrrrrqrrrRR',
      '.SSSSSSSSSRRRRRRRRRRRRRR',
      '.SsSSSSSsSSSSSSSSSSSSSSS',
      '.SSSGgGSSSSSGGGSSSSGGGSS',
      '.SSSGgGSSSSSGgGSsSSGgGSS',
      '.SSSSSSSSsSSGgGSSSSGgGSS',
      '.SsSSSSSSSSSGGGSSSsGGGSS',
      '.SSSSSSSSSSSSSSSSSSSSSSS',
      '.SSSSDDDDSSSSSSSSSSSSsSS',
      '.SsSSDddDSsSSSSSsSSSSSSS',
      '.SSSSDddDSSSSSSSSSSsSSSS',
      '.SSSSDddDSSsSSSSSSSSSSSS',
      'sssssDddDsssssssssssssss',
    ],
    palette: STONE_PALETTE,
    lit: STONE_LIT,
    glowChars: 'g',
    doorDx: 13,
    chimney: { x: 40, y: 12 },
  },
];

export const TIMBER_TEMPLATES: BuildingTemplate[] = [
  {
    rows: [
      '............YY............',
      '..........YYYYYY..........',
      '........YYYYyYYYYY........',
      '......YYYyYYYYYYyYYY......',
      '....YYYYYYYYyYYYYYYYYY....',
      '..YYyYYYYYYYYYYYYYyYYYY...',
      '.YYYYYYYYYYYYYYYYYYYYYYYY.',
      '.yyyyyyyyyyyyyyyyyyyyyyyy.',
      '..tttttttttttttttttttttt..',
      '..twwtwwwwwwtwwwwwwtwwwt..',
      '..twGGGwwwwwtwwwwwGGGwwt..',
      '..twGgGwwwtwwwtwwwGgGwwt..',
      '..twGgGwwtwwwwwtwwGgGwwt..',
      '..twGGGwtwwwwwwwtwGGGwwt..',
      '..tttttttttttttttttttttt..',
      '..twwwwwwwwwDDDDwwwwwwwt..',
      '..twwwtwwwwwDddDwwwwtwwt..',
      '..twwtwwwwwwDddDwwwwwtwt..',
      '..twtwwwwwwwDddDwwwwwwtt..',
      '..ttwwwwwwwwDddDwwwwwwwt..',
      '..tttttttttttttttttttttt..',
      '.sssssssssssDddDsssssssss.',
    ],
    palette: TIMBER_PALETTE,
    lit: TIMBER_LIT,
    glowChars: 'g',
    doorDx: 27,
    chimney: { x: 40, y: 6 },
  },
  {
    rows: [
      '.......RRRRRRRRRRRR.......',
      '.....RRrrrrrrrrrrrrRR.....',
      '...RRrrrrqrrrrrqrrrrrRR...',
      '.RRrrrrrrrrrrrrrrrrrrrrRR.',
      'RRRRRRRRRRRRRRRRRRRRRRRRRR',
      '.tttttttttttttttttttttttt.',
      '.twwwwwwwwwwwwwwwwwwwwwwt.',
      '.twGGGGwwwwwwwwwwwwGGGGwt.',
      '.twGggGwwtwwwwwwtwwGggGwt.',
      '.twGggGwwwtwwwwtwwwGggGwt.',
      '.twGGGGwwwwtwwtwwwwGGGGwt.',
      '.tttttttttttttttttttttttt.',
      '.AaAaAaAaAaAaAaAaAaAaAaAa.',
      '.aAaAaAaAaAaAaAaAaAaAaAaA.',
      '.AaAaAaAaAaAaAaAaAaAaAaAa.',
      '.t......................t.',
      '.t.bbbb....DDDD....bbbb.t.',
      '.t.bmmb....DddD....bffb.t.',
      '.t.bbbb....DddD....bbbb.t.',
      '.t.........DddD.........t.',
      '.tttttttttttttttttttttttt.',
      '.ssssssssssDddDssssssssss.',
    ],
    palette: TIMBER_PALETTE,
    lit: TIMBER_LIT,
    glowChars: 'g',
    doorDx: 25,
    chimney: null,
  },
  {
    rows: [
      '.........RRRRRRRR.........',
      '........RRrrrrrrRR........',
      '.......RRrrqrrrqrRR.......',
      '......RRrrrrrrrrrrRR......',
      '.....RRRRRRRRRRRRRRRR.....',
      '......tttttttttttttt......',
      '......twwGGGwwGGGwwt......',
      '......twwGgGwwGgGwwt......',
      '......twwGGGwwGGGwwt......',
      '......tttttttttttttt......',
      '....bbbbbbbbbbbbbbbbbb....',
      '....b.b.b.b.b.b.b.b.bb....',
      '....bbbbbbbbbbbbbbbbbb....',
      '.....twwwwtwwwwtwwwwt.....',
      '.....twGGGwDDDDwGGGwt.....',
      '.....twGgGwDddDwGgGwt.....',
      '.....twGgGwDddDwGgGwt.....',
      '.....twGGGwDddDwGGGwt.....',
      '.....twwwwwDddDwwwwwt.....',
      '.....tttttttttttttttt.....',
      '....sssssssDddDssssssss...',
    ],
    palette: TIMBER_PALETTE,
    lit: TIMBER_LIT,
    glowChars: 'g',
    doorDx: 25,
    chimney: { x: 30, y: 4 },
  },
];

export interface RenderedTemplate {
  day: HTMLCanvasElement;
  lit: HTMLCanvasElement;
  w: number;
  h: number;
  template: BuildingTemplate;
}

const templateCache = new Map<BuildingTemplate, RenderedTemplate>();

export function renderTemplate(t: BuildingTemplate): RenderedTemplate {
  const hit = templateCache.get(t);
  if (hit) return hit;
  const day = renderMatrix(t.rows, t.palette, 2);
  const lit = renderMatrix(t.rows, { ...t.palette, ...t.lit }, 2);
  const out = { day, lit, w: day.width, h: day.height, template: t };
  templateCache.set(t, out);
  return out;
}

// ── Small ambient sprites ────────────────────────────────────────────────────

export const BIRD_FRAMES = [
  ['b...b', '.b.b.', '..b..'],
  ['.....', 'bb.bb', '..b..'],
];
export const BAT_FRAMES = [
  ['k.....k', 'kk.k.kk', '.kkkkk.'],
  ['.......', '.kkkkk.', 'k..k..k'],
];
