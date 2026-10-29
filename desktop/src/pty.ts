// node-pty terminal registry: spawns Claude Code or a shell, streams data/exit
// through callbacks, tracks which renderer owns each pty, tears down on quit.

import * as fs from 'node:fs';
import * as os from 'node:os';
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

/** Low-level spawn of any program in a ConPTY; `owner` is the webContents id (-1 = none). */
export function spawnPty(
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
  cb: PtyCallbacks,
  owner = -1
): string {
  const id = `pty-${++seq}-${Date.now().toString(36)}`;
  const cwd = isDir(opts.cwd) ? opts.cwd : os.homedir();
  // Launched from inside a Claude Code session, the app inherits its "nested session" markers —
  // strip them so terminals opened here are first-class sessions with transcripts on.
  const cleanEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
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

/** Bridge-facing open: `shell` → powershell/$SHELL, otherwise claude [--resume id]. */
export function openPty(opts: PtyOpenOptions, owner: number, cb: PtyCallbacks): string {
  let file: string;
  let args: string[] = [];
  if (opts.shell) {
    file = IS_WIN ? 'powershell.exe' : process.env['SHELL'] || '/bin/bash';
  } else {
    const claude = resolveClaudePath();
    if (!claude) throw new Error('Claude Code binary not found (expected ~/.local/bin/claude or on PATH)');
    file = claude;
    if (opts.resumeSessionId) args = ['--resume', opts.resumeSessionId];
  }
  return spawnPty(file, args, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows }, cb, owner);
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
