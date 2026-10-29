// Crafting item id → cell on the "RPG crafting material icons" sheet
// (BizmasterStudios, CC-BY 4.0 — client/public/assets/icons/crafting/LICENSE.txt).
// The sheet has 16 icons; 28 items share them, re-tinted with a CSS filter
// where needed so pixels stay crisp.

import type { CSSProperties } from 'react';

/** Relative so it resolves under both the dev server and the file:// desktop build. */
export const ICON_SHEET_URL = 'assets/icons/crafting/nails.png';
export const ICON_CELL = 32;
export const ICON_SHEET_PX = 128;

export interface ItemIconDef {
  x: number;
  y: number;
  /** CSS filter that re-tints a reused cell. */
  filter?: string;
  /** Set when the sheet has no exact match and the closest cell is reused. */
  approx?: string;
}

// Sheet cells, row by row.
const NAILS = [0, 0] as const;
const PLANK = [1, 0] as const;
const ROD = [2, 0] as const;
const CLOTH = [3, 0] as const;
const COPPER_ORE = [0, 1] as const;
const IRON_ORE = [1, 1] as const;
const SILVER_NUGGET = [2, 1] as const;
const GOLD_NUGGET = [3, 1] as const;
const COPPER_BAR = [0, 2] as const;
const IRON_BAR = [1, 2] as const;
const SILVER_BAR = [2, 2] as const;
const GOLD_BAR = [3, 2] as const;
const FEATHER = [0, 3] as const;
const DRAGON_SCALE = [1, 3] as const;
const GEM = [2, 3] as const;
const LEATHER = [3, 3] as const;

function cell(c: readonly [number, number], filter?: string, approx?: string): ItemIconDef {
  const def: ItemIconDef = { x: c[0], y: c[1] };
  if (filter) def.filter = filter;
  if (approx) def.approx = approx;
  return def;
}

export const ITEM_ICONS: Record<string, ItemIconDef> = {
  // ── common ──
  'iron-ore': cell(IRON_ORE),
  'copper-ore': cell(COPPER_ORE),
  'coal-chunk': cell(IRON_ORE, 'brightness(0.55) saturate(0.4)', 'iron ore, darkened'),
  'oak-log': cell(PLANK, undefined, 'wood plank'),
  'pine-resin': cell(GOLD_NUGGET, 'sepia(0.35) saturate(1.35) hue-rotate(-14deg) brightness(0.95)', 'gold nugget, amber'),
  'stone-block': cell(COPPER_BAR, 'saturate(0) brightness(0.85)', 'copper bar, greyed'),
  'clay-lump': cell(COPPER_ORE, 'hue-rotate(-14deg) saturate(0.55) brightness(0.95)', 'copper ore, terracotta'),
  'linen-cloth': cell(CLOTH),
  'leather-scrap': cell(LEATHER),
  'wheat-bundle': cell(ROD, 'sepia(1) saturate(2.2) brightness(1.25)', 'wooden rod, golden'),
  // ── uncommon ──
  'silver-ore': cell(SILVER_NUGGET),
  'iron-ingot': cell(IRON_BAR),
  'steel-ingot': cell(SILVER_BAR, 'saturate(0.6) brightness(0.95)', 'silver bar, cooler'),
  'enchanted-thread': cell(CLOTH, 'hue-rotate(-130deg) saturate(1.6) brightness(1.05)', 'cloth, teal'),
  'owl-feather': cell(FEATHER),
  beeswax: cell(GOLD_NUGGET, 'saturate(0.6) brightness(1.15)', 'gold nugget, pale'),
  'glass-vial': cell(GEM, 'saturate(0.25) brightness(1.25)', 'gem, clear'),
  'monster-fang': cell(NAILS, 'sepia(0.55) brightness(1.15)', 'nails, bone'),
  // ── rare ──
  'gold-ore': cell(GOLD_NUGGET),
  'mithril-shard': cell(SILVER_BAR, 'hue-rotate(-10deg) saturate(1.9) brightness(1.18)', 'silver bar, blue sheen'),
  sapphire: cell(GEM, 'saturate(1.7) hue-rotate(8deg) brightness(0.9)', 'gem, deep blue'),
  emerald: cell(GEM, 'hue-rotate(-85deg) saturate(1.7)', 'gem, green'),
  'ancient-scroll': cell(CLOTH, 'sepia(1) saturate(0.7) brightness(1.1)', 'cloth, parchment'),
  'phoenix-feather': cell(FEATHER, 'hue-rotate(95deg) saturate(2.4) brightness(1.05)', 'feather, flame'),
  // ── epic ──
  'dragon-scale': cell(DRAGON_SCALE),
  'star-ruby': cell(GEM, 'hue-rotate(160deg) saturate(1.9) brightness(0.95)', 'gem, red'),
  'void-crystal': cell(GEM, 'hue-rotate(65deg) saturate(1.6) brightness(0.7) contrast(1.2)', 'gem, violet'),
  'philosophers-salt': cell(GOLD_BAR, undefined, 'gold bar'),
};

/** Unknown ids (catalog newer than the client) draw a greyed-out gem. */
const UNKNOWN_ICON: ItemIconDef = cell(GEM, 'saturate(0) brightness(0.6)');

export function itemIcon(itemId: string): ItemIconDef {
  return ITEM_ICONS[itemId] ?? UNKNOWN_ICON;
}

/** Inline style for a sprite box; `scale` is an integer so nearest-neighbour stays exact. */
export function itemIconStyle(itemId: string, scale: 1 | 2 | 3 = 2): CSSProperties {
  const def = itemIcon(itemId);
  const px = ICON_CELL * scale;
  const style: CSSProperties = {
    width: px,
    height: px,
    backgroundImage: `url(${ICON_SHEET_URL})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${ICON_SHEET_PX * scale}px ${ICON_SHEET_PX * scale}px`,
    backgroundPosition: `${-def.x * px}px ${-def.y * px}px`,
    imageRendering: 'pixelated',
  };
  if (def.filter) style.filter = def.filter;
  return style;
}
