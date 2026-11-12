// Where a terminal starts, and the env a resumed claude gets. Kept apart from pty.ts so callers
// (pop out) don't load node-pty, which main.ts deliberately loads lazily.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The coding folder this repo lives in (…/coding/rts-agents/desktop/dist → …/coding): trusted, unlike home. */
const CODING_DIR = path.resolve(__dirname, '..', '..', '..');

/**
 * The cwd when it exists; otherwise its nearest existing ancestor *below* home. Never home itself
 * (Claude asks to trust home on every start) and never outside it (/tmp, /); a path from the other
 * OS (G:\… on the Mac) is not followed. Those all fall back to the coding folder, then home.
 */
export function existingDir(p: string): string {
  const fallback = isDir(CODING_DIR) ? CODING_DIR : os.homedir();
  if (!path.isAbsolute(p)) return fallback;
  const home = path.resolve(os.homedir());
  const want = path.resolve(p);
  // Home itself never: Claude asks to trust it on every start (it never remembers that), and
  // `claude --resume` still finds a session filed under home when started from the coding folder.
  if (want === home) return fallback;
  if (isDir(want)) return want;
  // Climb only inside home — never up into /tmp, /, or another user's folder.
  const inHome = (d: string): boolean => {
    const rel = path.relative(home, d);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  for (let dir = path.dirname(want); inHome(dir); dir = path.dirname(dir)) {
    if (isDir(dir)) return dir;
  }
  return fallback;
}

export const RESUME_FULL_ENV: Record<string, string> = {
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: String(100 * 365 * 24 * 60),
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: String(1e12),
};
