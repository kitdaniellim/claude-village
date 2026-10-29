// Locates the Claude Code binary: ~/.local/bin first, then PATH via where/which.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const IS_WIN = process.platform === 'win32';
let cached: string | null | undefined;

/** Full path of claude(.exe) or null when it cannot be found. Cached after first lookup. */
export function resolveClaudePath(): string | null {
  if (cached !== undefined) return cached;

  const local = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return (cached = local);

  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (first && fs.existsSync(first)) return (cached = first);
  } catch {
    // not on PATH
  }
  return (cached = null);
}
