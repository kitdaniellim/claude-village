// Exposes `window.rts` (DesktopBridge) to the dashboard via contextBridge.
// Must stay identical in shape to client/src/types/desktop.d.ts.

import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopSettings, PtyHandle, PtyOpenOptions } from '../../client/src/types/desktop';

type DataCb = (data: string) => void;
type ExitCb = (code: number) => void;

const dataSubs = new Map<string, Set<DataCb>>();
const exitSubs = new Map<string, Set<ExitCb>>();

// One IPC listener per channel; fan out to subscribers by pty id.
ipcRenderer.on('pty:data', (_event, id: string, data: string) => {
  dataSubs.get(id)?.forEach((cb) => cb(data));
});
ipcRenderer.on('pty:exit', (_event, id: string, code: number) => {
  exitSubs.get(id)?.forEach((cb) => cb(code));
  exitSubs.delete(id);
  dataSubs.delete(id);
});

function subscribe<T>(subs: Map<string, Set<T>>, id: string, cb: T): () => void {
  let set = subs.get(id);
  if (!set) subs.set(id, (set = new Set<T>()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0 && subs.get(id) === set) subs.delete(id);
  };
}

// Passed by main.ts through webPreferences.additionalArguments.
const appVersion =
  process.argv.find((a) => a.startsWith('--rts-app-version='))?.slice('--rts-app-version='.length) ?? '0.0.0';

const bridge: DesktopBridge = {
  versions: {
    app: appVersion,
    electron: process.versions['electron'] ?? '',
    node: process.versions.node,
  },
  getSettings: (): Promise<DesktopSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<DesktopSettings>): Promise<DesktopSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  claudePath: (): Promise<string | null> => ipcRenderer.invoke('claude:path'),
  pty: {
    open: (opts: PtyOpenOptions): Promise<PtyHandle> => ipcRenderer.invoke('pty:open', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    close: (id) => ipcRenderer.send('pty:close', id),
    onData: (id, cb) => subscribe(dataSubs, id, cb),
    onExit: (id, cb) => subscribe(exitSubs, id, cb),
  },
  openExternal: (target) => ipcRenderer.send('shell:open', target),
};

contextBridge.exposeInMainWorld('rts', bridge);
