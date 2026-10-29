// One crafting-item sprite from the shared sheet, drawn at an integer scale.

import type { CSSProperties } from 'react';
import { itemIconStyle } from '../utils/itemIcons';

interface ItemIconProps {
  itemId: string;
  scale?: 1 | 2 | 3;
  /** Accessible name; omit for purely decorative uses next to the item's name. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export function ItemIcon({ itemId, scale = 2, label, className, style }: ItemIconProps) {
  const base = itemIconStyle(itemId, scale);
  return (
    <span
      className={className ? `item-icon ${className}` : 'item-icon'}
      style={{ display: 'inline-block', flexShrink: 0, ...base, ...style }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
