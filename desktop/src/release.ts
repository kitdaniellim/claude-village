// "Move into the village": end a Claude Code process running in an outside terminal so the
// app can resume the same session in its own tab (two processes on one session corrupt turns).
// Guarded: the pid must be claude, its session file must name this session, and it must not be ours.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReleaseSessionRequest, ReleaseSessionResult } from '../../client/src/types/desktop';

const IS_WIN = process.platform === 'win32';
const EXIT_WAIT_MS = 8_000;

function configDir(): string {
  const env = process.env['CLAUDE_CONFIG_DIR'];
  return env && env.trim() ? env : path.join(os.homedir(), '.claude');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== 'ESRCH';
  }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** Executable name of a pid ("claude.exe"), or null when it isn't running. */
async function imageName(pid: number): Promise<string | null> {
  if (IS_WIN) {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = /^"([^"]+)","(\d+)"/m.exec(out);
    return m && Number(m[2]) === pid ? m[1]! : null;
  }
  const out = await run('ps', ['-p', String(pid), '-o', 'comm=']);
  return out.trim() ? path.basename(out.trim()) : null;
}

/** Does `<config>/sessions/<pid>.json` say this pid runs this session? */
function sessionFileMatches(pid: number, sessionId: string): boolean {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(configDir(), 'sessions', `${pid}.json`), 'utf8')) as { sessionId?: unknown };
    return o.sessionId === sessionId;
  } catch {
    return false;
  }
}

const fail = (reason: ReleaseSessionResult['reason'], detail: string): ReleaseSessionResult => ({ ok: false, reason, detail });

export async function releaseSession(raw: unknown, ownPids: () => number[]): Promise<ReleaseSessionResult> {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReleaseSessionRequest>;
  const pid = Number(req.pid);
  const sessionId = req.sessionId;
  if (!Number.isInteger(pid) || pid <= 0) return fail('error', 'pid must be a positive integer');
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return fail('error', 'malformed sessionId');
  if (ownPids().includes(pid)) return fail('own', 'already running in a village tab');
  if (!alive(pid)) return { ok: true, reason: 'gone', detail: 'process had already exited' };
  try {
    const name = await imageName(pid);
    if (name === null) return { ok: true, reason: 'gone', detail: 'process had already exited' };
    if (!/^claude(\.exe)?$/i.test(name)) return fail('not-claude', `pid ${pid} is ${name}, not claude`);
    if (!sessionFileMatches(pid, sessionId)) return fail('mismatch', `pid ${pid} is not running session ${sessionId.slice(0, 8)}`);
    // The tree: claude plus its own children (MCP servers, shells). Its parent terminal is untouched.
    if (IS_WIN) await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (!alive(pid)) return { ok: true, reason: 'gone', detail: 'process exited' };
    return fail('error', err instanceof Error ? err.message : String(err));
  }
  const until = Date.now() + EXIT_WAIT_MS;
  while (alive(pid)) {
    if (Date.now() > until) return fail('timeout', `pid ${pid} did not exit`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: true, reason: 'released', detail: `closed pid ${pid}` };
}
