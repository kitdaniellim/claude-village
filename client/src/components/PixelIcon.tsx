// Crisp 12×12 pixel glyphs for the HUD, drawn as SVG rects in currentColor
// (colour emoji would break the pixel identity and vary per OS), the 16×16
// pixel swords (WarIcon, logo), and the bitmap BagIcon with a CSS-hinged flap.

import type { CSSProperties } from 'react';
import './PixelIcon.css';

const GLYPHS = {
  sun: [
    '.....##.....',
    '.#...##...#.',
    '..#......#..',
    '....####....',
    '...######...',
    '##.######.##',
    '##.######.##',
    '...######...',
    '....####....',
    '..#......#..',
    '.#...##...#.',
    '.....##.....',
  ],
  moon: [
    '............',
    '....####....',
    '..###...#...',
    '.###.....#..',
    '.###........',
    '###.........',
    '###.........',
    '.###........',
    '.###.....#..',
    '..###...#...',
    '....####....',
    '............',
  ],
  bell: [
    '.....##.....',
    '....####....',
    '...######...',
    '...######...',
    '...######...',
    '...######...',
    '..########..',
    '.##########.',
    '.##########.',
    '............',
    '.....##.....',
    '............',
  ],
  'bell-off': [
    '.....##....#',
    '....####..#.',
    '...#######..',
    '...#####.#..',
    '...####.##..',
    '...###.###..',
    '..###.####..',
    '.###.######.',
    '.##.#######.',
    '..#.........',
    '.#...##.....',
    '#...........',
  ],
  feed: [
    '............',
    '.##.#######.',
    '.##.#######.',
    '............',
    '.##.#######.',
    '.##.#######.',
    '............',
    '.##.#######.',
    '.##.#######.',
    '............',
    '.##.#####...',
    '.##.#####...',
  ],
  book: [
    '............',
    '.####..####.',
    '#....##....#',
    '#....##....#',
    '#.##.##.##.#',
    '#....##....#',
    '#.##.##.##.#',
    '#....##....#',
    '#....##....#',
    '.#...##...#.',
    '..###..###..',
    '............',
  ],
  backpack: [
    '....####....',
    '...#....#...',
    '..#.####.#..',
    '.##########.',
    '.#........#.',
    '.#..####..#.',
    '.#..#..#..#.',
    '.#..####..#.',
    '.#........#.',
    '.#........#.',
    '.##########.',
    '............',
  ],
  hammer: [
    '............',
    '....######..',
    '....######..',
    '....######..',
    '......##....',
    '......##....',
    '.....##.....',
    '....##......',
    '...##.......',
    '..##........',
    '.##.........',
    '............',
  ],
  gear: [
    '.....##.....',
    '..#.####.#..',
    '.##########.',
    '..###..###..',
    '.##......##.',
    '###......###',
    '###......###',
    '.##......##.',
    '..###..###..',
    '.##########.',
    '..#.####.#..',
    '.....##.....',
  ],
  'chevron-down': [
    '............',
    '............',
    '............',
    '.##......##.',
    '..##....##..',
    '...##..##...',
    '....####....',
    '.....##.....',
    '............',
    '............',
    '............',
    '............',
  ],
  'chevron-up': [
    '............',
    '............',
    '............',
    '............',
    '.....##.....',
    '....####....',
    '...##..##...',
    '..##....##..',
    '.##......##.',
    '............',
    '............',
    '............',
  ],
  restart: [
    '......#.....',
    '...#####....',
    '..#######...',
    '.####.##....',
    '.###..#.....',
    '.##......##.',
    '.##......##.',
    '.###....###.',
    '.####..####.',
    '..########..',
    '...######...',
    '............',
  ],
  x: [
    '............',
    '............',
    '.##......##.',
    '..##....##..',
    '...##..##...',
    '....####....',
    '....####....',
    '...##..##...',
    '..##....##..',
    '.##......##.',
    '............',
    '............',
  ],
} as const;

export type PixelIconName = keyof typeof GLYPHS;

interface PixelIconProps {
  name: PixelIconName;
  /** Rendered size in px (multiples of 12 stay pixel-exact). */
  size?: number;
  className?: string;
}

/** One SVG path for a `#`-grid: each horizontal run of `#` becomes one rect. */
function gridPath(rows: readonly string[]): string {
  const rects: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === '#') x += 1;
      rects.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return rects.join('');
}

export function PixelIcon({ name, size = 12, className }: PixelIconProps) {
  return (
    <svg
      className={className ? `pixel-icon ${className}` : 'pixel-icon'}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={gridPath(GLYPHS[name])} fill="currentColor" />
    </svg>
  );
}

// ── WarIcon: 16×16 pixel swords — upright pair at peace, a ⚔ X at war ──

/** One upright sword, point up (the right one is the same shifted 8 px); 1 px lines like the X. */
const PEACE_SWORD = [
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '...#....',
  '.#####..',
  '...#....',
  '...#....',
  '..###...',
  '..###...',
] as const;

/** Crossed swords like ⚔: 1 px blades meet at the centre, guards cross each blade at a right angle, pommels in the corners. */
const CROSSED_SWORDS = [
  '#..............#',
  '.#............#.',
  '..#..........#..',
  '...#........#...',
  '....#......#....',
  '.....#....#.....',
  '......#..#......',
  '.......##.......',
  '.......##.......',
  '..#...#..#...#..',
  '...#.#....#.#...',
  '....#......#....',
  '...#.#....#.#...',
  '..#...#..#...#..',
  '##............##',
  '##............##',
] as const;

/** Spark pixels in the gaps around the crossing (top, left, right). */
const CLASH_SPARKS = 'M7 1h2v1h-2zM7 3h2v1h-2zM1 7h1v2h-1zM3 7h1v2h-1zM14 7h1v2h-1zM12 7h1v2h-1z';

const PEACE_PATH = gridPath(PEACE_SWORD);
const WAR_PATH = gridPath(CROSSED_SWORDS);

interface WarIconProps {
  /** True = swords crossed (the host is at war). */
  war?: boolean;
  className?: string;
}

/** Peace swords tilt in and fade while the X scales in with a clash flash (see PixelIcon.css). */
export function WarIcon({ war = false, className }: WarIconProps) {
  const cls = ['war-icon', war ? 'war-icon-on' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg
      className={cls}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path className="war-icon-peace war-icon-peace-l" d={PEACE_PATH} fill="currentColor" />
      <path
        className="war-icon-peace war-icon-peace-r"
        d={PEACE_PATH}
        transform="translate(8 0)"
        fill="currentColor"
      />
      <path className="war-icon-x" d={WAR_PATH} fill="currentColor" />
      <path className="war-icon-flash" d={CLASH_SPARKS} />
    </svg>
  );
}

/** The static pixel ⚔ (app logo); 16 px or a multiple stays pixel-exact. */
export function CrossedSwordsIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={WAR_PATH} fill="currentColor" />
    </svg>
  );
}

// ── BagIcon: the backpack, as a sprite of the "Various inventory 24 pixel icon set" ──
// (OceansDream, CC-BY 3.0 — client/public/assets/icons/inventory-24/LICENSE.txt).

/** Relative so it resolves under both the dev server and the file:// desktop build. */
export const BAG_SHEET_URL = 'assets/icons/inventory-24/pixel_icons_by_oceansdream.png';
const BAG_SHEET_PX = 144;
export const BAG_PX = 24;
/** Sheet cell (col 0, row 4) → pixel origin. */
const BAG_CELL: readonly [number, number] = [0, 96];
/** Rows 0‥8 of the cell are the tan flap; the body is clipped to the rest. */
const BAG_FLAP_H = 9;

const BAG_SPRITE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  backgroundImage: `url(${BAG_SHEET_URL})`,
  backgroundRepeat: 'no-repeat',
  backgroundSize: `${BAG_SHEET_PX}px ${BAG_SHEET_PX}px`,
  backgroundPosition: `${-BAG_CELL[0]}px ${-BAG_CELL[1]}px`,
  imageRendering: 'pixelated',
};

interface BagIconProps {
  /** Open = flap hinged up + sparkle (the inventory panel is showing). */
  open?: boolean;
  className?: string;
}

/** 24 px bag; the same cell drawn twice (flap / body) so the flap can swing without a second image. */
export function BagIcon({ open = false, className }: BagIconProps) {
  const cls = ['bag-icon', open ? 'bag-icon-open' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} style={{ width: BAG_PX, height: BAG_PX }} aria-hidden="true">
      <span className="bag-icon-body" style={{ ...BAG_SPRITE, clipPath: `inset(${BAG_FLAP_H}px 0 0 0)` }} />
      <span className="bag-icon-flap" style={{ ...BAG_SPRITE, clipPath: `inset(0 0 ${BAG_PX - BAG_FLAP_H}px 0)` }} />
    </span>
  );
}
