// claude-village desktop shell: window + tray, boots the bun server / Vite client,
// and serves the `window.rts` bridge (settings, claude path, PTYs, focus, links, restart).
// `electron . --smoke` runs a headless self-test instead.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, type MenuItem } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesktopSettings, PtyOpenOptions } from '../../client/src/types/desktop';
import { resolveClaudePath } from './claude';
import { findTranscript, focusSession } from './focus';
import { releaseSession } from './release';
import { trayIcon, windowIcon } from './icon';
import {
  CLIENT_URL,
  ensureClient,
  ensureServer,
  killChildren,
  REPO_ROOT,
  SERVER_HEALTH_URL,
  type EnsureResult,
} from './services';
import { loadSettings, sanitizeSettings, saveSettings, settingsPath } from './settings';

const argv = process.argv.slice(1);
const SMOKE = argv.includes('--smoke');
const DEV = argv.includes('--dev');
const HIDDEN = argv.includes('--hidden');
/** Set by restartApp on the relaunched instance: wait for the old one to let go of the lock. */
const RELAUNCH = argv.includes('--relaunch');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const IS_MAC = process.platform === 'darwin';

// Launched from Finder / the Dock / a LaunchAgent, macOS hands GUI apps a bare PATH
// (/usr/bin:/bin:…) — bun, claude and the tools claude shells out to would all be missing.
if (process.platform !== 'win32') {
  const home = os.homedir();
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const have = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  process.env['PATH'] = [...have, ...extra.filter((d) => !have.includes(d))].join(':');
}
const CLIENT_INDEX = path.join(REPO_ROOT, 'client', 'dist', 'index.html');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: DesktopSettings;
let quitting = false;
let restarting = false;

// node-pty is loaded lazily so a broken native module degrades to "no terminals"
// (and a clear SMOKE FAIL) instead of crashing the whole app at startup.
type PtyModule = typeof import('./pty');
let ptyModule: PtyModule | null = null;
function loadPty(): PtyModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (ptyModule ??= require('./pty') as PtyModule);
}

// ── splash ───────────────────────────────────────────────────────────────────

function splashHtml(message: string, detail: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>claude-village</title><style>
html,body{height:100%;margin:0;background:#0f1117;color:#c9d1d9;font:14px/1.5 ui-monospace,Consolas,monospace}
body{display:flex;align-items:center;justify-content:center;text-align:center}
.sword{font-size:36px;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.detail{max-width:520px;margin:12px auto 0;opacity:.6;white-space:pre-wrap}
</style></head><body><div><div class="sword">&#9876;</div><div>${esc(message)}</div><div class="detail">${esc(detail)}</div></div></body></html>`;
}

function loadSplash(message: string, detail = ''): void {
  if (!win || win.isDestroyed()) return;
  // Rejects with ERR_ABORTED (-3) when the real page load supersedes it — expected.
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(message, detail))).catch(() => {});
}

// ── settings + login item ────────────────────────────────────────────────────

const LAUNCH_AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.rts-agents.desktop.plist');

/** macOS: setLoginItemSettings would register bare Electron.app (no app dir), so write a LaunchAgent. */
function applyMacLaunchAgent(s: DesktopSettings): void {
  if (!s.openAtLogin) {
    fs.rmSync(LAUNCH_AGENT, { force: true });
    return;
  }
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = [process.execPath, DESKTOP_DIR, ...(s.startMinimized ? ['--hidden'] : [])];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.rts-agents.desktop</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
  try {
    fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
    fs.writeFileSync(LAUNCH_AGENT, plist);
  } catch (err) {
    console.error('[desktop] could not write the login LaunchAgent:', (err as Error).message);
  }
}

/** Unpackaged app: registers electron.exe + this desktop dir (+ --hidden) as the login command. */
function applyLoginItem(s: DesktopSettings): void {
  if (IS_MAC) {
    applyMacLaunchAgent(s);
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: s.openAtLogin,
    path: process.execPath,
    args: [DESKTOP_DIR, ...(s.startMinimized ? ['--hidden'] : [])],
  });
}

function updateSettings(patch: unknown): DesktopSettings {
  const next = sanitizeSettings(settings, patch);
  const loginChanged = next.openAtLogin !== settings.openAtLogin || next.startMinimized !== settings.startMinimized;
  settings = next;
  saveSettings(settings);
  if (loginChanged) applyLoginItem(settings);
  refreshTrayMenu();
  return settings;
}

// ── window + tray ────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1117',
    title: 'claude-village',
    icon: windowIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--rts-app-version=${app.getVersion()}`],
    },
  });
  w.on('page-title-updated', (e) => e.preventDefault());
  // Closing hides to the tray; only the tray's Quit (or app.quit) really exits.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Vite may restart mid-load in dev; retry instead of leaving a blank page.
  w.webContents.on('did-fail-load', (_e, code, _desc, url) => {
    if (code === -3 || !url.startsWith(CLIENT_URL)) return;
    setTimeout(() => {
      if (!w.isDestroyed()) void w.loadURL(CLIENT_URL);
    }, 1500);
  });
  // A navigation/reload drops the renderer's subscriptions, so its PTYs are closed.
  // Ctrl+Shift+R = restart the whole app (also beats the default menu's force-reload).
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift || input.alt || input.meta) return;
    if (input.key.toLowerCase() !== 'r') return;
    e.preventDefault();
    void restartApp();
  });
  w.webContents.on('did-navigate', () => ptyModule?.closeOwnedPtys(w.webContents.id));
  w.webContents.on('destroyed', () => ptyModule?.closeOwnedPtys(w.webContents.id));
  return w;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: showWindow },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: settings.openAtLogin,
        click: (item: MenuItem) => {
          updateSettings({ openAtLogin: item.checked });
        },
      },
      { type: 'separator' },
      { label: 'Restart', click: () => void restartApp() },
      { label: 'Quit', click: quit },
    ])
  );
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('claude-village');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTrayMenu();
}

// ── ipc (window.rts bridge) ──────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, patch: unknown) => {
    // Bypass mode is only ever switched on by the person at the keyboard, through a native dialog —
    // never by the renderer alone (it loads from a dev server and could be driven by anything).
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    if (p['skipPermissions'] === true && !settings.skipPermissions) {
      const opts = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Skip permission prompts'],
        defaultId: 0,
        cancelId: 0,
        title: 'Skip permission prompts?',
        message: 'Start every village Claude with --dangerously-skip-permissions?',
        detail:
          'Claude will run tools (edit files, run commands) without asking first, in every terminal opened from now on. ' +
          'Its status line shows "bypass permissions on" while active. You can turn this off again in ⚙ Settings.',
      };
      const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response !== 1) return updateSettings({ ...p, skipPermissions: false });
    }
    return updateSettings(patch);
  });
  ipcMain.handle('claude:path', () => resolveClaudePath());

  ipcMain.handle('pty:open', (event, raw: unknown) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<PtyOpenOptions>;
    if (typeof o.cwd !== 'string' || o.cwd.length === 0) throw new Error('pty.open: cwd is required');
    const opts: PtyOpenOptions = {
      cwd: o.cwd,
      cols: Number(o.cols) || 80,
      rows: Number(o.rows) || 24,
      shell: o.shell === true,
    };
    if (typeof o.resumeSessionId === 'string' && o.resumeSessionId) {
      // Session ids are UUID-shaped; anything else would land in claude's argv as a flag.
      if (!/^[\w-]+$/.test(o.resumeSessionId)) throw new Error('pty.open: malformed resumeSessionId');
      opts.resumeSessionId = o.resumeSessionId;
      if (o.fork === true) opts.fork = true;
    }
    if (typeof o.name === 'string' && o.name.trim()) opts.name = o.name;
    const sender = event.sender;
    const pty = loadPty();
    const id = pty.openPty(
      opts,
      sender.id,
      {
        onData: (ptyId, data) => {
          if (!sender.isDestroyed()) sender.send('pty:data', ptyId, data);
        },
        onExit: (ptyId, code) => {
          if (!sender.isDestroyed()) sender.send('pty:exit', ptyId, code);
        },
      },
      settings.skipPermissions
    );
    return { id, pid: pty.ptyPid(id) ?? undefined };
  });
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    if (typeof id === 'string' && typeof data === 'string') ptyModule?.writePty(id, data);
  });
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    if (typeof id === 'string') ptyModule?.resizePty(id, Number(cols), Number(rows));
  });
  ipcMain.on('pty:close', (_e, id: string) => {
    if (typeof id === 'string') ptyModule?.closePty(id);
  });

  ipcMain.handle('session:focus', (_e, req: unknown) => focusSession(req));
  ipcMain.handle('session:transcript', (_e, sessionId: unknown) => findTranscript(sessionId));
  ipcMain.handle('session:release', (_e, req: unknown) => releaseSession(req, () => ptyModule?.ownedPids() ?? []));

  ipcMain.handle('tabs:load', () => loadTabState());
  ipcMain.on('tabs:save', (_e, json: unknown) => saveTabState(json));
  ipcMain.handle('prefs:load', (_e, key: unknown) => loadPref(key));
  ipcMain.on('prefs:save', (_e, key: unknown, json: unknown) => savePref(key, json));

  ipcMain.on('app:restart', () => void restartApp());

  ipcMain.on('shell:open', (_e, target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) return;
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i.test(target)) void shell.openExternal(target);
    else void shell.openPath(target);
  });
}

// ── terminal tab state (restored after a restart) ───────────────────────────

const TAB_STATE_MAX = 512 * 1024;

function tabStatePath(): string {
  return path.join(app.getPath('userData'), 'tabs.json');
}

function loadTabState(): string | null {
  try {
    const raw = fs.readFileSync(tabStatePath(), 'utf8');
    return raw.length <= TAB_STATE_MAX ? raw : null;
  } catch {
    return null;
  }
}

/** Written synchronously, so it is on disk before a restart kills anything. */
function saveTabState(json: unknown): void {
  if (typeof json !== 'string' || json.length > TAB_STATE_MAX) return;
  try {
    JSON.parse(json);
    const file = tabStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', json);
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.error('[desktop] could not save tab state:', (err as Error).message);
  }
}

// ── UI preferences backup (prefs.json: { key: json }) ───────────────────────

const PREF_KEY_RE = /^[a-z0-9-]{1,40}$/;
const PREF_VALUE_MAX = 4 * 1024;

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'prefs.json');
}

function readPrefs(): Record<string, string> {
  try {
    const o: unknown = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
    return o !== null && typeof o === 'object' ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function loadPref(key: unknown): string | null {
  if (typeof key !== 'string' || !PREF_KEY_RE.test(key)) return null;
  const v = readPrefs()[key];
  return typeof v === 'string' ? v : null;
}

/** Same atomic write as the tab state; keys and sizes are bounded. */
function savePref(key: unknown, json: unknown): void {
  if (typeof key !== 'string' || !PREF_KEY_RE.test(key)) return;
  if (typeof json !== 'string' || json.length > PREF_VALUE_MAX) return;
  try {
    JSON.parse(json);
    const prefs = readPrefs();
    prefs[key] = json;
    const file = prefsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(prefs));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.error('[desktop] could not save preference:', (err as Error).message);
  }
}

/** Chromium commits localStorage lazily; push it to disk before an abrupt exit. */
function flushRendererStorage(): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.session.flushStorageData();
  } catch {
    // window already torn down
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  console.log(`[desktop] ${new Date().toISOString()} start pid ${process.pid}${RELAUNCH ? ' (relaunch)' : ''}`);
  settings = loadSettings();
  if (settings.openAtLogin) applyLoginItem(settings); // keep the registry entry's path current
  registerIpc();
  createTray();
  win = createWindow();
  if (!HIDDEN) win.once('ready-to-show', () => win?.show());
  await loadVillage(DEV);
}

/** Newest file mtime under a directory (recursive); 0 when unreadable. */
function newestMtime(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else {
      try {
        newest = Math.max(newest, fs.statSync(p).mtimeMs);
      } catch {
        // vanished mid-scan
      }
    }
  }
  return newest;
}

/** client/dist is only usable when it was built after the last change in client/src. */
function builtClientFresh(): boolean {
  try {
    return fs.statSync(CLIENT_INDEX).mtimeMs >= newestMtime(path.join(REPO_ROOT, 'client', 'src'));
  } catch {
    return false; // no build at all
  }
}

/** Ensure the server (+ dev client when needed) and load the village into the window. */
async function loadVillage(dev: boolean): Promise<void> {
  if (!win || win.isDestroyed()) return;
  loadSplash('starting village…', 'checking server on :4444 and client on :4445');

  // A stale build would show an old village — fall back to the live Vite dev server instead.
  const prod = !dev && builtClientFresh();
  if (!dev && !prod && fs.existsSync(CLIENT_INDEX)) {
    console.log('[desktop] client/dist is older than client/src — using the dev server (bun run build refreshes it)');
  }
  const [server, client] = await Promise.all([
    ensureServer(),
    prod ? Promise.resolve<EnsureResult>('already-running') : ensureClient(),
  ]);
  console.log(`[desktop] server ${server}; client ${prod ? 'built client/dist' : client}; settings ${settingsPath()}`);
  if (!win || win.isDestroyed()) return;

  if (server === 'failed') {
    console.error(`[desktop] ${SERVER_HEALTH_URL} never answered — is bun on PATH? (bun run dev:server)`);
  }
  if (prod) {
    await win.loadFile(CLIENT_INDEX);
  } else if (client === 'failed') {
    loadSplash(
      'could not start the village',
      `${CLIENT_URL} did not answer within 30 s.\nIs bun installed and on PATH? Run "bun start" in\n${REPO_ROOT}\nthen relaunch.`
    );
  } else {
    await win.loadURL(CLIENT_URL);
  }
}

// ── restart ("easy button": window.rts.restart, tray, Ctrl+Shift+R) ─────────

/** desktop/src (or the shared bridge types) changed after the last tsc build. */
function shellStale(): boolean {
  const bridgeTypes = path.join(REPO_ROOT, 'client', 'src', 'types', 'desktop.d.ts');
  let typesMtime = 0;
  try {
    typesMtime = fs.statSync(bridgeTypes).mtimeMs;
  } catch {
    // missing types — tsc will say so
  }
  const src = Math.max(newestMtime(path.join(DESKTOP_DIR, 'src')), typesMtime);
  return src > newestMtime(path.join(DESKTOP_DIR, 'dist'));
}

/** `tsc -p desktop` run by Electron-as-node (no npm/npx needed); async so the splash can paint. */
function rebuildShell(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let tsc: string;
    try {
      tsc = require.resolve('typescript/bin/tsc', { paths: [DESKTOP_DIR] });
    } catch {
      resolve({ ok: false, output: 'typescript is not installed in desktop/ (npm install)' });
      return;
    }
    let output = '';
    const child = spawn(process.execPath, [tsc, '-p', DESKTOP_DIR], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}

/** Rebuild a stale shell, stop terminals + the server/client we spawned, then relaunch in --dev. */
async function restartApp(): Promise<void> {
  if (restarting) return;
  restarting = true;
  console.log(`[desktop] ${new Date().toISOString()} restart requested — relaunching`);
  if (win && !win.isDestroyed() && !win.isVisible()) showWindow();
  // The renderer saves its tabs on every change (localStorage + tabs:save); flush before the splash unloads it.
  flushRendererStorage();
  if (shellStale()) {
    loadSplash('rebuilding shell…', 'desktop/src changed — tsc -p desktop');
    const { ok, output } = await rebuildShell();
    if (!ok) {
      // tsc still emits on type errors; show them briefly, then relaunch with what was emitted.
      console.error(`[desktop] shell rebuild failed:
${output}`);
      loadSplash('shell rebuild reported errors — restarting anyway', output.slice(0, 800));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  loadSplash('restarting…', 'stopping terminals, server and client');
  ptyModule?.closeAllPtys();
  killChildren();
  quitting = true;
  // Free the lock first; the new instance also retries briefly (--relaunch) in case we linger.
  app.releaseSingleInstanceLock();
  const keep = argv.filter((a) => a.startsWith('--user-data-dir'));
  app.relaunch({ args: [DESKTOP_DIR, '--dev', '--relaunch', ...keep] });
  app.exit(0);
}

/** Single-instance lock; a relaunched instance waits up to 5 s for the old one to exit. */
async function acquireLock(): Promise<boolean> {
  if (app.requestSingleInstanceLock()) return true;
  if (!RELAUNCH) return false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

// ── smoke test (`electron . --smoke`) ────────────────────────────────────────

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function finishSmoke(code: number, line: string, extra?: string): void {
  ptyModule?.closeAllPtys();
  process.stdout.write((extra ? `[smoke] ${extra}\n` : '') + line + '\n', () => app.exit(code));
}

async function smoke(): Promise<void> {
  await app.whenReady();
  const claude = resolveClaudePath();
  const icon = trayIcon();
  const info =
    `electron ${process.versions['electron']} · node ${process.versions.node} · claude ${claude ?? '(not found)'}` +
    ` · tray icon ${icon.getSize().width}x${icon.getSize().height}${icon.isEmpty() ? ' (EMPTY!)' : ''}`;
  if (!claude) {
    finishSmoke(1, `SMOKE FAIL claude binary not found — ${info}`);
    return;
  }
  let out = '';
  const timer = setTimeout(
    () => finishSmoke(1, `SMOKE FAIL "claude --version" did not exit within 30 s; output: ${stripAnsi(out)}`),
    30_000
  );
  try {
    loadPty().spawnPty(claude, ['--version'], { cwd: os.homedir(), cols: 80, rows: 24 }, {
      onData: (_id, data) => {
        out += data;
      },
      onExit: (_id, exitCode) => {
        clearTimeout(timer);
        const text = stripAnsi(out);
        const version = /\d+\.\d+\.\d+[^\r\n]*/.exec(text)?.[0]?.trim();
        if (exitCode === 0 && version) finishSmoke(0, `SMOKE OK ${version}`, info);
        else finishSmoke(1, `SMOKE FAIL claude exited ${exitCode}; output: ${text || '(empty)'}`, info);
      },
    });
  } catch (err) {
    clearTimeout(timer);
    finishSmoke(1, `SMOKE FAIL node-pty failed to load/spawn: ${(err as Error).message}`, info);
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

app.setAppUserModelId('rts-agents.desktop');

function startApp(): void {
  // A relaunch (bun run desktop, the .cmd, the login item) reloads the village instead of
  // just focusing a window that may still be showing an old build.
  app.on('second-instance', (_e, argv) => {
    showWindow();
    void loadVillage(argv.includes('--dev'));
  });
  app.on('before-quit', () => {
    if (!restarting) console.log(`[desktop] ${new Date().toISOString()} quit (tray Quit / Cmd+Q / logout)`);
    quitting = true;
    flushRendererStorage();
  });
  app.on('will-quit', () => {
    ptyModule?.closeAllPtys();
    killChildren();
  });
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
  // macOS: clicking the Dock icon (or the launcher .app again) brings the hidden window back.
  app.on('activate', () => {
    if (win) showWindow();
  });
  void app.whenReady().then(boot);
}

if (SMOKE) {
  void smoke();
} else {
  void acquireLock().then((locked) => {
    if (locked) startApp();
    else app.quit();
  });
}
