// Terminal drawer width: ~44% of the viewport by default, min 420px, never so
// wide the village drops under 420px. Remembered in localStorage.

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'rts-agents.drawer.v1';
export const DRAWER_MIN = 420;
const PARTY_W = 260;
const VILLAGE_MIN = 420;

export function clampDrawerWidth(w: number, viewportW: number = window.innerWidth): number {
  const max = Math.max(DRAWER_MIN, viewportW - PARTY_W - VILLAGE_MIN);
  return Math.round(Math.min(max, Math.max(DRAWER_MIN, w)));
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { width?: unknown }).width === 'number') {
        return clampDrawerWidth((parsed as { width: number }).width);
      }
    }
  } catch {
    // fall through to the default
  }
  return clampDrawerWidth(window.innerWidth * 0.44);
}

export function useDrawerWidth(): [number, (w: number) => void] {
  const [width, setWidthState] = useState<number>(loadWidth);

  const setWidth = useCallback((w: number) => {
    const next = clampDrawerWidth(w);
    setWidthState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: next }));
    } catch {
      // storage unavailable — width lives for this page load only
    }
  }, []);

  // Re-clamp when the window shrinks so the village never collapses.
  useEffect(() => {
    const onResize = (): void => setWidthState((w) => clampDrawerWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return [width, setWidth];
}
