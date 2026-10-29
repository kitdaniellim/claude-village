// Map editor: layout persistence (localStorage, v2) + the DOM overlay shown
// while editing. The layout maps a place id (tavern, cities, dungeon, lair,
// wild spots) to the tile position of its footprint's top-left corner. Drag
// hit-testing happens on the Village canvas.

import { DEFAULT_PLACE_TILES, TILES_X, TILES_Y } from '../world/constants';
import type { TilePos } from '../world/constants';
import './MapEditor.css';

export type { TilePos };
export { TILES_X, TILES_Y };

/** place id → footprint top-left tile. Places missing here get a default / free slot. */
export type LayoutMap = Record<string, TilePos>;

export const LAYOUT_STORAGE_KEY = 'rts-agents.layout.v2';

export const DEFAULT_LAYOUT: LayoutMap = { ...DEFAULT_PLACE_TILES };

/** Tavern default before the 18x12 footprint; a saved copy of it is re-centred to the new default. */
const LEGACY_TAVERN_TILE: TilePos = { tx: 42, ty: 26 };

function isTilePos(v: unknown): v is TilePos {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['tx'] === 'number' && Number.isFinite(o['tx']) && typeof o['ty'] === 'number' && Number.isFinite(o['ty']);
}

/** Load the saved layout over the defaults, dropping invalid entries. */
export function loadLayout(): LayoutMap {
  const layout: LayoutMap = { ...DEFAULT_LAYOUT };
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === null) return layout;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return layout;
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isTilePos(v)) continue;
      if (id === 'tavern' && v.tx === LEGACY_TAVERN_TILE.tx && v.ty === LEGACY_TAVERN_TILE.ty) continue;
      layout[id] = {
        tx: Math.max(0, Math.min(TILES_X - 1, Math.round(v.tx))),
        ty: Math.max(0, Math.min(TILES_Y - 1, Math.round(v.ty))),
      };
    }
  } catch {
    // corrupted storage — defaults win
  }
  return layout;
}

export function saveLayout(layout: LayoutMap): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // storage may be unavailable (private mode) — editing still works in-memory
  }
}

export function clearSavedLayout(): void {
  try {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ── Overlay component ────────────────────────────────────────────────────────

interface MapEditorProps {
  onReset: () => void;
  onClose: () => void;
}

export default function MapEditor({ onReset, onClose }: MapEditorProps) {
  return (
    <div className="map-editor-overlay">
      <div className="map-editor-banner">
        <span className="map-editor-icon" aria-hidden="true">
          ⚒
        </span>
        <span className="map-editor-text">Map editor — drag cities, the dungeon, the lair and wild spots to new tiles</span>
        <button type="button" className="map-editor-btn" onClick={onReset}>
          Reset layout
        </button>
        <button type="button" className="map-editor-btn map-editor-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
