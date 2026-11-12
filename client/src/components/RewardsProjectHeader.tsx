// Place kind glyphs for the backpack's place chips and quest-log rows
// (castle / skull / flame / mug / pine / tent).

import type { PlaceDef } from '../world/registry';
import { HANDOFFS_PLACE, WILDERNESS_PLACE } from '../utils/rewards';

// ── Place kind glyphs (12×12, currentColor; same pixel grammar as PixelIcon) ──

const KIND_GLYPHS = {
  city: [
    '#.#......#.#',
    '###.#..#.###',
    '###.####.###',
    '.#..####..#.',
    '.##########.',
    '.##########.',
    '.####..####.',
    '.###....###.',
    '.###....###.',
    '.###....###.',
    '############',
    '............',
  ],
  dungeon: [
    '............',
    '...######...',
    '..########..',
    '.##########.',
    '.##..##..##.',
    '.##..##..##.',
    '.##########.',
    '..####.###..',
    '...######...',
    '...#.##.#...',
    '...######...',
    '............',
  ],
  lair: [
    '.....#......',
    '.....##.....',
    '....###.....',
    '....####.#..',
    '...#####.##.',
    '..#########.',
    '..###.#####.',
    '.###...####.',
    '.###...####.',
    '.####.#####.',
    '..########..',
    '...######...',
  ],
  tavern: [
    '............',
    '..#######...',
    '.#########..',
    '.#.#.#.#.#..',
    '.########.##',
    '.########..#',
    '.########..#',
    '.########.##',
    '.########...',
    '.########...',
    '..#######...',
    '............',
  ],
  wild: [
    '.....##.....',
    '....####....',
    '...######...',
    '....####....',
    '..########..',
    '...######...',
    '.##########.',
    '..########..',
    '############',
    '.....##.....',
    '.....##.....',
    '....####....',
  ],
  camp: [
    '.....##.....',
    '....#..#....',
    '....#..#....',
    '...#....#...',
    '...#.##.#...',
    '..#..##..#..',
    '..#.####.#..',
    '.#..####..#.',
    '.#.######.#.',
    '#..######..#',
    '############',
    '............',
  ],
  scroll: [
    '.#########..',
    '#.........#.',
    '.#########.#',
    '..#.......#.',
    '..#.#####.#.',
    '..#.......#.',
    '..#.####..#.',
    '..#.......#.',
    '..#.#####.#.',
    '.#########.#',
    '#.........#.',
    '.#########..',
  ],
} as const;

type KindGlyph = keyof typeof KIND_GLYPHS;

function glyphPath(rows: readonly string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === '#') x += 1;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  return d;
}

const KIND_PATHS = Object.fromEntries(
  (Object.keys(KIND_GLYPHS) as KindGlyph[]).map((k) => [k, glyphPath(KIND_GLYPHS[k])]),
) as Record<KindGlyph, string>;

function glyphFor(place: PlaceDef): KindGlyph {
  if (place.id === HANDOFFS_PLACE.id) return 'scroll';
  return place.id === WILDERNESS_PLACE.id ? 'camp' : place.kind;
}

/** Castle / skull / flame / mug / pine / tent for the place's kind. */
export function PlaceKindIcon({ place, size = 12, className }: { place: PlaceDef; size?: number; className?: string }) {
  const glyph = glyphFor(place);
  return (
    <svg
      className={`pixel-icon rp-kind rp-kind-${glyph}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d={KIND_PATHS[glyph]} fill="currentColor" />
    </svg>
  );
}
