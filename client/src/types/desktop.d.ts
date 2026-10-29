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
}

export interface PtyOpenOptions {
  /** Absolute directory the terminal starts in. */
  cwd: string;
  /** Resume this Claude Code session (`claude --resume <id>`); omit to start a fresh `claude`. */
  resumeSessionId?: string;
  /** Launch a plain shell instead of Claude Code. */
  shell?: boolean;
  cols: number;
  rows: number;
}

export interface PtyHandle {
  /** Server-side id for this terminal; pass to write/resize/close. */
  id: string;
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
  };
  /** Open a path/URL with the OS default handler. */
  openExternal(target: string): void;
}

declare global {
  interface Window {
    rts?: DesktopBridge;
  }
}

export {};
