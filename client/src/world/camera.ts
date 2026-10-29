// Camera: screen = world * z + (ox, oy). Fit, clamp, zoom-around-cursor and
// centre-on helpers; the eased transitions live in Village.tsx.

import { WORLD_H, WORLD_W } from './constants';

export interface View {
  z: number;
  ox: number;
  oy: number;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;

export function fitZoom(cw: number, ch: number): number {
  return Math.min(cw / WORLD_W, ch / WORLD_H);
}

export function fitView(cw: number, ch: number): View {
  const z = fitZoom(cw, ch);
  return { z, ox: (cw - WORLD_W * z) / 2, oy: (ch - WORLD_H * z) / 2 };
}

/** Keep the world covering the viewport (or centred when it is smaller). */
export function clampView(v: View, cw: number, ch: number): View {
  const ww = WORLD_W * v.z;
  const wh = WORLD_H * v.z;
  const ox = ww <= cw ? (cw - ww) / 2 : Math.min(0, Math.max(cw - ww, v.ox));
  const oy = wh <= ch ? (ch - wh) / 2 : Math.min(0, Math.max(ch - wh, v.oy));
  return { z: v.z, ox, oy };
}

export function zoomAt(v: View, sx: number, sy: number, factor: number, cw: number, ch: number): View {
  const minZ = Math.min(MIN_ZOOM, fitZoom(cw, ch));
  const z = Math.max(minZ, Math.min(MAX_ZOOM, v.z * factor));
  const k = z / v.z;
  return clampView({ z, ox: sx - (sx - v.ox) * k, oy: sy - (sy - v.oy) * k }, cw, ch);
}

export function centerOn(wx: number, wy: number, z: number, cw: number, ch: number): View {
  return clampView({ z, ox: cw / 2 - wx * z, oy: ch / 2 - wy * z }, cw, ch);
}

export function toWorld(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.ox) / v.z, y: (sy - v.oy) / v.z };
}

export function toScreen(v: View, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * v.z + v.ox, y: wy * v.z + v.oy };
}
