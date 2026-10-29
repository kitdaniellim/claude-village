// RTS Agents desktop shell: window + tray, boots the bun server / Vite client,
// and serves the `window.rts` bridge (settings, claude path, PTYs, links).
// `electron . --smoke` runs a headless self-test instead.

import { app, BrowserWindow, ipcMain, Menu, shell, Tray, type MenuItem } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesktopSettings, PtyOpenOptions } from '../../client/src/types/desktop';
import { resolveClaudePath } from './claude';
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

const DESKTOP_DIR = path.resolve(__dirname, '..');
const CLIENT_INDEX = path.join(REPO_ROOT, 'client', 'dist', 'index.html');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: DesktopSettings;
let quitting = false;

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
  return `<!doctype html><html><head><meta charset="utf-8"><title>RTS Agents</title><style>
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

/** Unpackaged app: registers electron.exe + this desktop dir (+ --hidden) as the login command. */
function applyLoginItem(s: DesktopSettings): void {
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
    title: 'RTS Agents',
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
      { label: 'Quit', click: quit },
    ])
  );
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('RTS Agents');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTrayMenu();
}

// ── ipc (window.rts bridge) ──────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch: unknown) => updateSettings(patch));
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
    if (typeof o.resumeSessionId === 'string' && o.resumeSessionId) opts.resumeSessionId = o.resumeSessionId;
    const sender = event.sender;
    const id = loadPty().openPty(opts, sender.id, {
      onData: (ptyId, data) => {
        if (!sender.isDestroyed()) sender.send('pty:data', ptyId, data);
      },
      onExit: (ptyId, code) => {
        if (!sender.isDestroyed()) sender.send('pty:exit', ptyId, code);
      },
    });
    return { id };
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

  ipcMain.on('shell:open', (_e, target: unknown) => {
    if (typeof target !== 'string' || target.length === 0) return;
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i.test(target)) void shell.openExternal(target);
    else void shell.openPath(target);
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  settings = loadSettings();
  if (settings.openAtLogin) applyLoginItem(settings); // keep the registry entry's path current
  registerIpc();
  createTray();
  win = createWindow();
  if (!HIDDEN) win.once('ready-to-show', () => win?.show());
  loadSplash('starting village…', 'checking server on :4444 and client on :4445');

  const prod = !DEV && fs.existsSync(CLIENT_INDEX);
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

if (SMOKE) {
  void smoke();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => {
    ptyModule?.closeAllPtys();
    killChildren();
  });
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
  void app.whenReady().then(boot);
}
