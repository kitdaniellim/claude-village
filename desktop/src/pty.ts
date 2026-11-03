// node-pty terminal registry: spawns Claude Code or a shell, streams data/exit
// through callbacks, tracks which renderer owns each pty, tears down on quit.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodePty from 'node-pty';
import type { PtyOpenOptions } from '../../client/src/types/desktop';
import { resolveClaudePath } from './claude';

const IS_WIN = process.platform === 'win32';
const ptys = new Map<string, { pty: nodePty.IPty; owner: number }>();
let seq = 0;

export interface PtyCallbacks {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
}

function isDir(p: string): boolean {
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

/** Low-level spawn of any program in a ConPTY; `owner` is the webContents id (-1 = none). */
export function spawnPty(
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
  cb: PtyCallbacks,
  owner = -1
): string {
  const id = `pty-${++seq}-${Date.now().toString(36)}`;
  const cwd = existingDir(opts.cwd);
  // Launched from inside a Claude Code session, the app inherits that session's env
  // (CLAUDE_CODE_SESSION_ID would make a fresh claude adopt the parent's session!) —
  // strip every CLAUDE* var except the config-dir override.
  const cleanEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR') delete env[k];
    }
    return env;
  };
  const pty = nodePty.spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols > 0 ? opts.cols : 80,
    rows: opts.rows > 0 ? opts.rows : 24,
    cwd,
    env: cleanEnv(),
    useConpty: true,
  });
  ptys.set(id, { pty, owner });
  pty.onData((data) => cb.onData(id, data));
  pty.onExit(({ exitCode }) => {
    ptys.delete(id);
    cb.onExit(id, exitCode);
  });
  return id;
}

/** `--name` value: node-pty quotes each argv entry itself, so only drop what can't be in a name. */
function safeName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 80);
}

/** Bridge-facing open: `shell` → powershell/$SHELL, otherwise claude [--resume id [--fork-session]] [--name n]. */
export function openPty(opts: PtyOpenOptions, owner: number, cb: PtyCallbacks, skipPermissions = false): string {
  let file: string;
  const args: string[] = [];
  if (opts.shell) {
    file = IS_WIN ? 'powershell.exe' : process.env['SHELL'] || '/bin/bash';
  } else {
    const claude = resolveClaudePath();
    if (!claude) throw new Error('Claude Code binary not found (expected ~/.local/bin/claude or on PATH)');
    file = claude;
    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      if (opts.fork) args.push('--fork-session');
    }
    const name = opts.name ? safeName(opts.name) : '';
    if (name) args.push('--name', name);
  }
  return spawnPty(file, args, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows }, cb, owner);
}

/** Pids of every process we spawned — never released by "Move into the village". */
export function ownedPids(): number[] {
  return [...ptys.values()].map((e) => e.pty.pid);
}

/** OS pid of the spawned process (claude.exe under ConPTY), or null once it is gone. */
export function ptyPid(id: string): number | null {
  return ptys.get(id)?.pty.pid ?? null;
}

export function writePty(id: string, data: string): void {
  ptys.get(id)?.pty.write(data);
}

export function resizePty(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) ptys.get(id)?.pty.resize(cols, rows);
}

export function closePty(id: string): void {
  const entry = ptys.get(id);
  if (!entry) return;
  ptys.delete(id);
  try {
    // ConPTY kill alone can leave claude.exe running headless — take the whole tree.
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(entry.pty.pid), '/T', '/F'], { windowsHide: true });
    entry.pty.kill();
  } catch {
    // already exited
  }
}

export function closeOwnedPtys(owner: number): void {
  for (const [id, entry] of ptys) if (entry.owner === owner) closePty(id);
}

export function closeAllPtys(): void {
  for (const id of [...ptys.keys()]) closePty(id);
}
