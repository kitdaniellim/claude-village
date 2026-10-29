// One hero portrait (CSS sprite) in a 2 px frame of the hero colour. Until
// the sheet loads — or when there is no session — the old coloured square
// with its pixel face stands in, so colour identity never flickers.

import { useSyncExternalStore } from 'react';
import { PORTRAIT_PX, portraitFor, portraitSheetState, portraitStyle, subscribePortraitSheet } from '../utils/portraits';
import './Portrait.css';

interface PortraitProps {
  /** null → plain coloured square (tabs launched from a place, not a hero). */
  sessionId: string | null;
  color: string;
  /** 1 = 32 px (tabs, chips), 2 = 64 px (party cards). */
  scale?: 1 | 2;
  /** Draw from the squire pool (youthful faces) instead of the knight pools. */
  squire?: boolean;
  /** Accessible name; omit when the name sits right next to it. */
  label?: string;
  className?: string;
}

export function Portrait({ sessionId, color, scale = 1, squire = false, label, className }: PortraitProps) {
  const ready = useSyncExternalStore(subscribePortraitSheet, portraitSheetState) === 'ok';
  const cell = sessionId ? portraitFor(sessionId, squire) : null;
  const sprite = ready && cell ? portraitStyle(cell, scale) : null;
  const box = PORTRAIT_PX * scale + 4;
  return (
    <span
      className={`portrait portrait-${scale}x ${squire ? 'portrait-squire' : ''} ${className ?? ''}`}
      style={{ width: box, height: box, borderColor: color, background: sprite ? undefined : color }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={cell?.name}
    >
      {sprite ? <span className="portrait-img" style={sprite} /> : <span className="portrait-face" />}
    </span>
  );
}
