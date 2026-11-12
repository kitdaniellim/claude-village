// node-pty terminal registry: spawns Claude Code or a shell, streams data/exit
// through callbacks, tracks which renderer owns each pty, tears down on quit.

import { spawnSync } from 'node:child_process';
import * as nodePty from 'node-pty';
import type { PtyOpenOptions } from '../../client/src/types/desktop';
import { resolveClaudePath } from './claude';
import { existingDir, RESUME_FULL_ENV } from './cwd';

const IS_WIN = process.platform === 'win32';
interface PtyEntry {
  pty: nodePty.IPty;
  owner: number;
  /** The renderer's tab id: a reloaded page reattaches by it instead of starting a second claude. */
  key: string | null;
  /** Recent output, replayed to a reattaching page so its screen comes back. */
  buffer: string;
  /** Swapped on reattach so output follows the new page. */
  cb: PtyCallbacks;
  /** Pending kill after the page let go (cancelled by a reattach). */
  killTimer: NodeJS.Timeout | null;
}
const ptys = new Map<string, PtyEntry>();
/** Output kept per terminal for a reattach (enough for a full screen plus scrollback). */
const REPLAY_MAX = 256 * 1024;
let seq = 0;

export interface PtyCallbacks {
  onData: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
}

/** Low-level spawn of any program in a ConPTY; `owner` is the webContents id (-1 = none). */
export function spawnPty(
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env?: Record<string, string> },
  cb: PtyCallbacks,
  owner = -1,
  key: string | null = null
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
    env: { ...cleanEnv(), ...opts.env },
    useConpty: true,
  });
  const entry: PtyEntry = { pty, owner, key, buffer: '', cb, killTimer: null };
  ptys.set(id, entry);
  pty.onData((data) => {
    entry.buffer += data;
    if (entry.buffer.length > REPLAY_MAX) entry.buffer = entry.buffer.slice(-REPLAY_MAX);
    entry.cb.onData(id, data);
  });
  pty.onExit(({ exitCode }) => {
    if (entry.killTimer) clearTimeout(entry.killTimer);
    ptys.delete(id);
    entry.cb.onExit(id, exitCode);
  });
  return id;
}


/** `--name` value: node-pty quotes each argv entry itself, so only drop what can't be in a name. */
function safeName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 80);
}

/** Bridge-facing open: `shell` → powershell/$SHELL, otherwise claude [--resume id [--fork-session]] [--name n]. */
/**
 * A live terminal opened under this key and not yet killed: take it over (new owner + callbacks,
 * cancel the pending kill) and hand back its recent output. Null when there is none.
 */
export function reattachPty(key: string, owner: number, cb: PtyCallbacks): { id: string; replay: string } | null {
  for (const [id, entry] of ptys) {
    if (entry.key !== key) continue;
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.killTimer = null;
    entry.owner = owner;
    entry.cb = cb;
    return { id, replay: entry.buffer };
  }
  return null;
}

/** Keys of the terminals still running (a reloaded page brings those tabs back live, not asleep). */
export function liveKeys(): string[] {
  return [...ptys.values()].filter((e) => e.key !== null).map((e) => e.key as string);
}

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
  // Waking a tab means "carry on": Claude Code otherwise stops a long, old session (> 70 min, > 100k
  // tokens) to ask "Resume from summary / full session?". Lift both limits out of reach for our resumes.
  const env = opts.resumeSessionId && !opts.shell ? RESUME_FULL_ENV : undefined;
  const key = typeof opts.key === 'string' && opts.key ? opts.key : null;
  return spawnPty(file, args, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env }, cb, owner, key);
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

/**
 * Close a terminal. With `graceMs` the kill waits that long so a reloading / hot-reloading page can
 * reattach (by key) to the same claude — editing the village must not cut its sessions off.
 */
export function closePty(id: string, graceMs = 0): void {
  const entry = ptys.get(id);
  if (!entry) return;
  if (graceMs > 0 && entry.key !== null) {
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.killTimer = setTimeout(() => closePty(id), graceMs);
    return;
  }
  if (entry.killTimer) clearTimeout(entry.killTimer);
  ptys.delete(id);
  try {
    // ConPTY kill alone can leave claude.exe running headless — take the whole tree.
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(entry.pty.pid), '/T', '/F'], { windowsHide: true });
    entry.pty.kill();
  } catch {
    // already exited
  }
}

export function closeOwnedPtys(owner: number, graceMs = 0): void {
  for (const [id, entry] of ptys) if (entry.owner === owner) closePty(id, graceMs);
}

export function closeAllPtys(): void {
  for (const id of [...ptys.keys()]) closePty(id);
}
