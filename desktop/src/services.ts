// Ensures the bun server (:4444) and Vite client (:4445) are up, spawning
// them from the repo root when they are not, and kills what it spawned on quit.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { net } from 'electron';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const SERVER_HEALTH_URL = 'http://localhost:4444/healthz';
export const CLIENT_URL = 'http://localhost:4445';

const IS_WIN = process.platform === 'win32';
const children = new Map<string, ChildProcess>();
/** Set by killChildren so deliberate kills are not answered with a respawn. */
let stopping = false;
const serverRespawns: number[] = [];

export type EnsureResult = 'already-running' | 'spawned' | 'failed';

/** True when a GET to the URL answers 2xx within the timeout. */
export async function isUp(url: string, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Poll until the URL answers, backing off 250 ms → 2 s, up to `deadlineMs`. */
export async function waitFor(url: string, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  let delay = 250;
  while (Date.now() < end) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 2000);
  }
  return false;
}

/** `bun run <script>` from the repo root; stdout/stderr are relayed to our console. */
function spawnBun(script: string): ChildProcess | null {
  if (children.has(script)) return children.get(script) ?? null;
  const child = spawn(IS_WIN ? 'bun.cmd' : 'bun', ['run', script], {
    cwd: REPO_ROOT,
    env: process.env,
    shell: IS_WIN, // .cmd shims need cmd.exe on Windows
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${script}] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${script}] ${d}`));
  child.on('error', (err) => console.error(`[desktop] failed to spawn bun run ${script}:`, err.message));
  child.on('exit', (code, signal) => {
    console.log(`[desktop] bun run ${script} exited (${code ?? signal})`);
    if (children.get(script) === child) children.delete(script);
    if (script === 'dev:server' && !stopping) respawnServer();
  });
  children.set(script, child);
  return child;
}

/** The server we started died on its own: bring it back (max 3 times a minute). */
function respawnServer(): void {
  const now = Date.now();
  while (serverRespawns.length > 0 && now - (serverRespawns[0] ?? 0) > 60_000) serverRespawns.shift();
  if (serverRespawns.length >= 3) {
    console.error('[desktop] bun run dev:server keeps exiting — not respawning again (use Restart in the tray)');
    return;
  }
  serverRespawns.push(now);
  setTimeout(() => {
    if (!stopping) void ensureServer().then((r) => console.log(`[desktop] server respawn: ${r}`));
  }, 1000);
}

export async function ensureServer(): Promise<EnsureResult> {
  if (await isUp(SERVER_HEALTH_URL)) return 'already-running';
  if (!spawnBun('dev:server')) return 'failed';
  return (await waitFor(SERVER_HEALTH_URL, 30_000)) ? 'spawned' : 'failed';
}

export async function ensureClient(): Promise<EnsureResult> {
  if (await isUp(CLIENT_URL)) return 'already-running';
  if (!spawnBun('dev:client')) return 'failed';
  return (await waitFor(CLIENT_URL, 30_000)) ? 'spawned' : 'failed';
}

/** Kill every process tree we spawned (taskkill /T on Windows, SIGTERM elsewhere). */
export function killChildren(): void {
  stopping = true;
  for (const [script, child] of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      if (IS_WIN) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
      console.log(`[desktop] stopped bun run ${script} (pid ${child.pid})`);
    } catch {
      // already gone
    }
  }
  children.clear();
}
