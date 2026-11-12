// Bridge exposed by the Electron preload as `window.rts`. Absent in a plain
// browser tab — every consumer must feature-detect (`if (window.rts)`).
// Mirrored by desktop/src/preload.ts; keep both identical.

export interface DesktopSettings {
  /** Register the app to launch when the user logs in. */
  openAtLogin: boolean;
  /** Start minimised to the tray when launched at login. */
  startMinimized: boolean;
  /** Play sound cues (turn done / error / needs you). */
  sound: boolean;
  /** Start every claude with --dangerously-skip-permissions (no tool-permission prompts). */
  skipPermissions: boolean;
}

export interface PtyOpenOptions {
  /** Absolute directory the terminal starts in. */
  cwd: string;
  /** Resume this Claude Code session (`claude --resume <id>`); omit to start a fresh `claude`. */
  resumeSessionId?: string;
  /** Launch a plain shell instead of Claude Code. */
  shell?: boolean;
  /** With `resumeSessionId`: `--fork-session` — a new session id that keeps the parent's context (a "squire"). */
  fork?: boolean;
  /** `--name <name>`: display name for the new/forked session (e.g. "Nameless", "Squire of MY VILLAGE"). */
  name?: string;
  /** The tab's id: if a terminal opened under this key is still running (the page reloaded), reattach to it. */
  key?: string;
  cols: number;
  rows: number;
}

export interface PtyHandle {
  /** Server-side id for this terminal; pass to write/resize/close. */
  id: string;
  /** OS pid of the spawned process (claude.exe) — matches AgentState.pid once its session file appears. */
  pid?: number;
  /** Reattached to a terminal that kept running across a reload: its recent output, to repaint the screen. */
  replay?: string;
}

export interface FocusSessionRequest {
  /** pid of the running claude process (AgentState.pid). */
  pid: number;
  /** Names to look for in Windows Terminal tab titles, best first (e.g. customTitle, then title). */
  titles: string[];
  /** Locate only — do not select the tab or move any window. */
  dryRun?: boolean;
  /** Select the tab but leave window z-order/focus alone (diagnostics). */
  skipForeground?: boolean;
}

export interface FocusSessionResult {
  ok: boolean;
  /** wt-tab = WT window fronted + tab selected; window = host window fronted; the rest are failures. */
  method: 'wt-tab' | 'window' | 'not-found' | 'pid-gone' | 'unsupported' | 'error';
  detail: string;
  /** Friendly host name, e.g. "Windows Terminal", "VS Code", "console window". */
  app: string | null;
  /** Title of the window that was (or would be) fronted. */
  window: string | null;
  /** Name of the WT tab selected, if any. */
  tab: string | null;
  /** Windows actually gave the window the foreground (it can refuse focus stealing). */
  foreground: boolean;
  /** Process chain walked, "name#pid" from claude upwards (diagnostics). */
  chain: string[];
}

export interface TranscriptLookup {
  /** `<config>/projects/<slug>/<sessionId>.jsonl` exists. */
  found: boolean;
  /** The project slug dir it lives in (cwd with non-alphanumerics → "-"). */
  projectDir: string | null;
}

export interface ReleaseSessionRequest {
  /** pid of the outside claude process (AgentState.pid). */
  pid: number;
  /** The session it must be running — checked against `<config>/sessions/<pid>.json`. */
  sessionId: string;
}

export interface ReleaseSessionResult {
  /** True when the process is gone (closed now, or already exited) and the session can be resumed here. */
  ok: boolean;
  reason: 'released' | 'gone' | 'own' | 'not-claude' | 'mismatch' | 'timeout' | 'error';
  detail: string;
}

export interface PopOutRequest {
  sessionId: string;
  /** The folder to resume it in (its transcript's folder). */
  cwd: string;
}

export interface PopOutResult {
  ok: boolean;
  detail: string;
}

export interface DesktopBridge {
  /** Electron + app versions, for the About row. */
  versions: { app: string; electron: string; node: string };
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  /** Full path of the Claude Code binary the bridge will spawn, or null if not found. */
  claudePath(): Promise<string | null>;
  pty: {
    open(opts: PtyOpenOptions): Promise<PtyHandle>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    close(id: string): void;
    /** Returns an unsubscribe function. */
    onData(id: string, cb: (data: string) => void): () => void;
    onExit(id: string, cb: (code: number) => void): () => void;
    /** Keys of terminals still running in the main process (absent on older shells). */
    live?(): Promise<string[]>;
  };
  /** Bring the external terminal running this claude pid to the front (Windows). Absent on older shells. */
  focusSession?(req: FocusSessionRequest): Promise<FocusSessionResult>;
  /** Is this session's transcript on disk (so `claude --resume` can find it)? Absent on older shells. */
  findTranscript?(sessionId: string): Promise<TranscriptLookup>;
  /** "Move into the village": close the outside claude running this session (verified first). Absent on older shells. */
  releaseSession?(req: ReleaseSessionRequest): Promise<ReleaseSessionResult>;
  /** "Pop out": resume this session in the OS terminal (Terminal.app / Windows Terminal). Absent on older shells. */
  popOutSession?(req: PopOutRequest): Promise<PopOutResult>;
  /** Terminal tabs saved by the main process too (a restart can switch origin file:// → localhost). Absent on older shells. */
  tabState?: {
    load(): Promise<string | null>;
    save(json: string): void;
  };
  /** UI preferences (night, WAR, scale, grid…) backed up by the main process, same reason as tabState. Absent on older shells. */
  prefs?: {
    load(key: string): Promise<string | null>;
    save(key: string, json: string): void;
  };
  /** Open a path/URL with the OS default handler. */
  openExternal(target: string): void;
  /** Quit and relaunch the whole app: rebuilds a stale shell, restarts the server/client it started, reloads the map. */
  restart(): void;
}

declare global {
  interface Window {
    rts?: DesktopBridge;
  }
}

export {};
