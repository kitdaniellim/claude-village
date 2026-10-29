// Tavern rest spots the user dragged heroes to, per session id. Stored as
// offsets from the plaza centre so a tavern moved in the map editor keeps them.

import type { Pt } from './pixel';

export const HERO_SPOTS_KEY = 'rts-agents.hero-spots.v1';

type Spots = Record<string, Pt>;

function isPt(v: unknown): v is Pt {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['x'] === 'number' && Number.isFinite(o['x']) && typeof o['y'] === 'number' && Number.isFinite(o['y']);
}

function read(): Spots {
  try {
    const raw = localStorage.getItem(HERO_SPOTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Spots = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) if (isPt(v)) out[id] = { x: v.x, y: v.y };
    return out;
  } catch {
    return {};
  }
}

function write(spots: Spots): void {
  try {
    localStorage.setItem(HERO_SPOTS_KEY, JSON.stringify(spots));
  } catch {
    // storage unavailable — the spot still holds for this page load
  }
}

export function loadHeroSpot(sessionId: string): Pt | null {
  return read()[sessionId] ?? null;
}

export function saveHeroSpot(sessionId: string, offset: Pt): void {
  const spots = read();
  spots[sessionId] = { x: Math.round(offset.x), y: Math.round(offset.y) };
  write(spots);
}

export function clearHeroSpot(sessionId: string): void {
  const spots = read();
  if (!(sessionId in spots)) return;
  delete spots[sessionId];
  write(spots);
}
