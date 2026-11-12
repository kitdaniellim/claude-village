// "Pop out": continue a village session in the OS terminal (Terminal.app / Windows Terminal), so a
// restart or rebuild of the village can't take it down. The renderer closes its own tab first;
// this only starts `claude --resume <id>` outside. Inputs are validated and passed as argv, never
// spliced into script text.

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PopOutRequest, PopOutResult } from '../../client/src/types/desktop';
import { resolveClaudePath } from './claude';
import { existingDir, RESUME_FULL_ENV } from './cwd';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// AppleScript reads everything from argv: [shell command]. `do script` opens a new Terminal window.
const MAC_SCRIPT = `on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run`;

/** POSIX single-quote a value for the shell line Terminal runs. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fail(detail: string): PopOutResult {
  return { ok: false, detail };
}

export function popOutSession(raw: unknown, skipPermissions: boolean): Promise<PopOutResult> {
  const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<PopOutRequest>;
  const sessionId = req.sessionId;
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return Promise.resolve(fail('malformed sessionId'));
  const claude = resolveClaudePath();
  if (!claude) return Promise.resolve(fail('Claude Code binary not found'));
  const cwd = existingDir(typeof req.cwd === 'string' && req.cwd ? req.cwd : os.homedir());
  const args = [...(skipPermissions ? ['--dangerously-skip-permissions'] : []), '--resume', sessionId];

  if (IS_MAC) {
    const env = Object.entries(RESUME_FULL_ENV).map(([k, v]) => `${k}=${shq(v)}`);
    const line = `cd ${shq(cwd)} && ${env.join(' ')} ${shq(claude)} ${args.map(shq).join(' ')}`;
    return new Promise((resolve) => {
      execFile('osascript', ['-e', MAC_SCRIPT, line], { timeout: 15_000 }, (err, _out, stderr) => {
        if (err) resolve(fail((stderr || err.message).trim() || 'osascript failed'));
        else resolve({ ok: true, detail: 'Opened in Terminal' });
      });
    });
  }

  if (IS_WIN) {
    const env = { ...process.env, ...RESUME_FULL_ENV };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE') && k !== 'CLAUDE_CONFIG_DIR' && !(k in RESUME_FULL_ENV)) delete env[k];
    const wt = path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps', 'wt.exe');
    const hasWt = fs.existsSync(wt);
    try {
      // Paths and the session id never contain `"` (validated / Windows paths), so quoting is safe.
      const q = (s: string): string => `"${s}"`;
      const child = hasWt
        ? spawn(wt, ['-w', 'new', '-d', cwd, claude, ...args], { env, detached: true, stdio: 'ignore' })
        : spawn('cmd.exe', ['/c', 'start', '""', '/d', q(cwd), q(claude), ...args], {
            env,
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
          });
      child.unref();
      return Promise.resolve({ ok: true, detail: hasWt ? 'Opened in Windows Terminal' : 'Opened in a console window' });
    } catch (err) {
      return Promise.resolve(fail(err instanceof Error ? err.message : String(err)));
    }
  }
  return Promise.resolve(fail('Pop out supports macOS and Windows'));
}
