// DesktopSettings persisted as JSON in <userData>/settings.json.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSettings } from '../../client/src/types/desktop';

export const DEFAULT_SETTINGS: DesktopSettings = {
  openAtLogin: false,
  startMinimized: false,
  sound: true,
};

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Coerce an untrusted object (file contents or IPC patch) onto the settings shape. */
export function sanitizeSettings(base: DesktopSettings, patch: unknown): DesktopSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const bool = (key: keyof DesktopSettings): boolean =>
    typeof p[key] === 'boolean' ? (p[key] as boolean) : base[key];
  return {
    openAtLogin: bool('openAtLogin'),
    startMinimized: bool('startMinimized'),
    sound: bool('sound'),
  };
}

export function loadSettings(): DesktopSettings {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return sanitizeSettings(DEFAULT_SETTINGS, raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: DesktopSettings): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
