// Watcher — discovery + tailing of Claude Code session logs.
//
// Reliability layers (any log change must reach the store well within 2 s):
//   1. fs.watch with recursive:true per <claudeDir>/projects (falls back to
//      per-project-subdir watchers where recursive isn't supported)
//   2. a 10 s rescan that re-discovers new .claude* dirs / project subdirs /
//      session files AND stat-compares every known file (catch-all)
//   3. a 1 s stat-poll over recently-active files (mtime within 5 min) — the
//      hard guarantee even if fs.watch events are lost entirely.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STARTUP_LOOKBACK_MS, STARTUP_TAIL_BYTES } from './types';
import { SessionParser } from './parser';
import type { AgentStore } from './state';

const RESCAN_INTERVAL_MS = 10_000;
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const ACTIVE_WINDOW_MS = 5 * 60_000;
const READ_DEBOUNCE_MS = 100;
const RESCAN_DEBOUNCE_MS = 500;
const NEWLINE = 0x0a;
/** Consecutive non-ENOENT stat failures tolerated before untracking a file. */
const STAT_FAILURE_UNTRACK_AFTER = 5;

let tempDirsCache: string[] | null = null;

/**
 * Claude's project slugs for the OS temp dir, e.g. "C--Users-kitda-AppData-Local-Temp". Both the
 * reported and the resolved path: on macOS tmpdir() is /var/folders/… but claude records the
 * symlink-resolved /private/var/folders/….
 */
const TEMP_SLUGS = [...new Set(tempDirs().map((d) => d.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()))];

/** The OS temp dir as reported and with symlinks resolved (resolved once; polled per session file). */
export function tempDirs(): string[] {
  if (tempDirsCache) return tempDirsCache;
  const dirs = [os.tmpdir()];
  try {
    dirs.push(fs.realpathSync(os.tmpdir()));
  } catch {
    // unresolvable — the reported path is all we have
  }
  return (tempDirsCache = dirs);
}

/** True for the temp dir's own slug and any sub-folder of it. */
export function isTempProjectSlug(slug: string): boolean {
  const s = slug.toLowerCase();
  return TEMP_SLUGS.some((t) => s === t || s.startsWith(`${t}-`));
}

/** Best-effort error code (falls back to the message) for log lines. */
function errCode(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Home-dir scan, distinguishing "no installs" ([]) from a failed readdir ({error}). */
function readClaudeDirs(home: string): string[] | { error: unknown } {
  const dirs: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch (err) {
    return { error: err };
  }
  for (const entry of entries) {
    if (!/^\.claude/.test(entry.name)) continue;
    const projectsPath = path.join(home, entry.name, 'projects');
    try {
      if (fs.statSync(projectsPath).isDirectory()) dirs.push(path.join(home, entry.name));
    } catch {
      // no projects/ subdir (or unreadable) — not a session install
    }
  }
  return dirs.sort();
}

/** Scan the home dir for `.claude*` directories that contain a `projects/` subdir. */
export function discoverClaudeDirs(home: string = os.homedir()): string[] {
  const result = readClaudeDirs(home);
  return Array.isArray(result) ? result : [];
}

interface FileState {
  path: string;
  sessionId: string;
  installDir: string;
  projectDir: string;
  /** Bytes consumed so far. Always advanced to a line boundary. */
  offset: number;
  /** File size at the last read/stat — change detection without re-reading. */
  size: number;
  mtimeMs: number;
  parser: SessionParser;
  debounce: ReturnType<typeof setTimeout> | null;
  /** True when we started mid-file: discard bytes before the first newline. */
  skipToNewline: boolean;
  /** Consecutive non-ENOENT stat failures (transient EPERM/EBUSY tolerance). */
  statFailures: number;
  /** Consecutive read failures — for rate-limited stale-session warnings. */
  readFailures: number;
  /** True once existing content was tailed (stale files skip it until their process shows up live). */
  tailed: boolean;
}

export class Watcher {
  private claudeDirs: string[] = [];
  private readonly files = new Map<string, FileState>();
  /** <claudeDir>/projects path → watcher (recursive where supported). */
  private readonly projectsWatchers = new Map<string, fs.FSWatcher>();
  /** projects paths where recursive fs.watch failed → use per-subdir watchers. */
  private readonly recursiveFailed = new Set<string>();
  private readonly subdirWatchers = new Map<string, fs.FSWatcher>();
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private rescanDebounce: ReturnType<typeof setTimeout> | null = null;
  private dirsListener: ((dirs: string[]) => void) | null = null;
  /** Session ids with a running process — always polled, and tailed even when their file looked stale. */
  private liveSessionIds = new Set<string>();
  /** Paths whose fs.watch failure was already logged (log once per path). */
  private readonly watchWarned = new Set<string>();
  private homeScanWarned = false;

  constructor(
    private readonly store: AgentStore,
    private readonly home: string = os.homedir()
  ) {}

  /** Synchronous initial scan, then periodic rescans + active-file polling. */
  start(): void {
    this.rescan();
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_INTERVAL_MS);
    this.pollTimer = setInterval(() => this.pollActive(), ACTIVE_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.rescanTimer !== null) clearInterval(this.rescanTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.rescanDebounce !== null) clearTimeout(this.rescanDebounce);
    this.rescanTimer = null;
    this.pollTimer = null;
    this.rescanDebounce = null;
    for (const state of this.files.values()) {
      if (state.debounce !== null) clearTimeout(state.debounce);
      state.debounce = null;
    }
    for (const watcher of this.projectsWatchers.values()) this.closeQuietly(watcher);
    for (const watcher of this.subdirWatchers.values()) this.closeQuietly(watcher);
    this.projectsWatchers.clear();
    this.subdirWatchers.clear();
  }

  getClaudeDirs(): string[] {
    return this.claudeDirs.slice();
  }

  /** Number of session files currently tracked (for the startup banner). */
  getTrackedFileCount(): number {
    return this.files.size;
  }

  onDirsChange(listener: (dirs: string[]) => void): void {
    this.dirsListener = listener;
  }

  // ── discovery ──────────────────────────────────────────────────────────────

  private rescan(): void {
    const scanned = readClaudeDirs(this.home);
    let dirs: string[];
    if (Array.isArray(scanned)) {
      dirs = scanned;
      this.homeScanWarned = false;
    } else {
      // A failed home scan is NOT "no installs" — keep the current dirs and
      // watchers instead of tearing everything down, and retry next rescan.
      if (!this.homeScanWarned) {
        this.homeScanWarned = true;
        console.warn(
          `[rts-agents] failed to scan ${this.home} for .claude dirs ` +
            `(${errCode(scanned.error)}) — keeping current watchers`
        );
      }
      dirs = this.claudeDirs;
    }
    if (dirs.join('\0') !== this.claudeDirs.join('\0')) {
      this.claudeDirs = dirs;
      try {
        this.dirsListener?.(dirs.slice());
      } catch {
        // listener errors must not break scanning
      }
    }

    const liveProjectsPaths = new Set<string>();
    for (const dir of dirs) {
      const projectsPath = path.join(dir, 'projects');
      liveProjectsPaths.add(projectsPath);
      this.ensureProjectsWatcher(projectsPath);
      this.scanProjects(projectsPath, path.basename(dir));
    }

    // Drop watchers for installs that disappeared.
    for (const [projectsPath, watcher] of this.projectsWatchers) {
      if (!liveProjectsPaths.has(projectsPath)) {
        this.closeQuietly(watcher);
        this.projectsWatchers.delete(projectsPath);
        this.recursiveFailed.delete(projectsPath);
      }
    }
    for (const [subPath, watcher] of this.subdirWatchers) {
      let live = false;
      for (const projectsPath of liveProjectsPaths) {
        if (subPath.startsWith(projectsPath + path.sep)) {
          live = true;
          break;
        }
      }
      if (!live) {
        this.closeQuietly(watcher);
        this.subdirWatchers.delete(subPath);
      }
    }
  }

  private scanProjects(projectsPath: string, installDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectsPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const subPath = path.join(projectsPath, entry.name);
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(subPath).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      // Projects under the OS temp dir are headless helpers (e.g. the remember plugin's
      // `claude -p` summariser in %TEMP%\remember-summarizer-cwd-*), never user sessions.
      if (isTempProjectSlug(entry.name)) continue;

      if (this.recursiveFailed.has(projectsPath)) this.ensureSubdirWatcher(subPath);

      let files: string[];
      try {
        files = fs.readdirSync(subPath);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const abs = path.join(subPath, name);
        const known = this.files.get(abs);
        if (!known) {
          this.trackFile(abs, installDir, entry.name);
        } else {
          // Catch-all: pick up changes even if every fs.watch event was lost.
          try {
            const st = fs.statSync(abs);
            known.statFailures = 0;
            known.mtimeMs = st.mtimeMs;
            if (st.size !== known.size) this.scheduleRead(known);
          } catch (err) {
            this.handleStatFailure(known, err);
          }
        }
      }
    }
  }

  // ── fs.watch layer ─────────────────────────────────────────────────────────

  /** Log an fs.watch failure once per target so degraded mode is never silent. */
  private warnWatchFailure(target: string, err: unknown, consequence: string): void {
    if (this.watchWarned.has(target)) return;
    this.watchWarned.add(target);
    const code = errCode(err);
    console.warn(`[rts-agents] fs.watch failed for ${target} (${code}) — ${consequence}`);
    if (code === 'ENOSPC') {
      console.warn(
        '[rts-agents] hint: inotify watch limit reached — raise fs.inotify.max_user_watches'
      );
    }
  }

  private ensureProjectsWatcher(projectsPath: string): void {
    if (this.projectsWatchers.has(projectsPath)) return;

    let watcher: fs.FSWatcher | null = null;
    if (!this.recursiveFailed.has(projectsPath)) {
      try {
        watcher = fs.watch(projectsPath, { recursive: true, persistent: false }, (_event, filename) =>
          this.onWatchEvent(projectsPath, filename)
        );
      } catch (err) {
        // recursive unsupported on this platform/filesystem (or creation failed)
        this.recursiveFailed.add(projectsPath);
        this.warnWatchFailure(`${projectsPath} (recursive)`, err, 'using per-subdir watchers');
      }
    }
    if (!watcher) {
      // Fallback: non-recursive watch on projects/ (new subdirs → rescan);
      // per-subdir watchers are added by scanProjects.
      try {
        watcher = fs.watch(projectsPath, { persistent: false }, () => this.scheduleRescan());
      } catch (err) {
        this.warnWatchFailure(
          projectsPath,
          err,
          `falling back to polling; updates may lag up to ${RESCAN_INTERVAL_MS / 1000}s`
        );
        return;
      }
    }
    watcher.on('error', (err) => {
      this.warnWatchFailure(`${projectsPath} (runtime)`, err, 'watcher closed; rescan rebuilds');
      this.closeQuietly(watcher);
      this.projectsWatchers.delete(projectsPath);
      this.recursiveFailed.add(projectsPath); // be conservative; rescan rebuilds
      this.scheduleRescan();
    });
    this.projectsWatchers.set(projectsPath, watcher);
  }

  private ensureSubdirWatcher(subPath: string): void {
    if (this.subdirWatchers.has(subPath)) return;
    try {
      const watcher = fs.watch(subPath, { persistent: false }, (_event, filename) =>
        this.onWatchEvent(subPath, filename)
      );
      watcher.on('error', (err) => {
        this.warnWatchFailure(`${subPath} (runtime)`, err, 'watcher closed; rescan rebuilds');
        this.closeQuietly(watcher);
        this.subdirWatchers.delete(subPath);
      });
      this.subdirWatchers.set(subPath, watcher);
    } catch (err) {
      this.warnWatchFailure(
        subPath,
        err,
        `falling back to polling; updates may lag up to ${RESCAN_INTERVAL_MS / 1000}s`
      );
    }
  }

  private onWatchEvent(basePath: string, filename: unknown): void {
    if (typeof filename !== 'string' || filename.length === 0) {
      this.scheduleRescan();
      return;
    }
    const abs = path.join(basePath, filename);
    const known = this.files.get(abs);
    if (known) {
      this.scheduleRead(known);
    } else if (filename.endsWith('.jsonl')) {
      this.scheduleRescan(); // brand-new session file
    } else {
      this.scheduleRescan(); // new project subdir or anything else — cheap, debounced
    }
  }

  private scheduleRescan(): void {
    if (this.rescanDebounce !== null) return;
    this.rescanDebounce = setTimeout(() => {
      this.rescanDebounce = null;
      this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  // ── poll layer ─────────────────────────────────────────────────────────────

  /** Absolute log path for a session (its sub-agent transcripts live beside it). */
  getSessionPath(sessionId: string): string | null {
    for (const state of this.files.values()) {
      if (state.sessionId === sessionId) return state.path;
    }
    return null;
  }

  /** Called by the live-process registry; late-tails any tracked file we skipped as stale. */
  setLiveSessions(ids: Iterable<string>): void {
    this.liveSessionIds = new Set(ids);
    for (const state of this.files.values()) {
      if (state.tailed || !this.liveSessionIds.has(state.sessionId)) continue;
      state.tailed = true;
      if (state.size > STARTUP_TAIL_BYTES) {
        state.offset = state.size - STARTUP_TAIL_BYTES;
        state.skipToNewline = true;
      } else {
        state.offset = 0;
      }
      this.readAppended(state);
    }
  }

  private pollActive(): void {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    for (const state of this.files.values()) {
      if (state.mtimeMs < cutoff && !this.liveSessionIds.has(state.sessionId)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(state.path);
      } catch (err) {
        this.handleStatFailure(state, err);
        continue;
      }
      state.statFailures = 0;
      state.mtimeMs = st.mtimeMs;
      if (st.size !== state.size) this.scheduleRead(state);
    }
  }

  /**
   * ENOENT → the file is really gone: untrack now (sweep retires the agent).
   * Anything else (EPERM/EBUSY during AV scans or delete-pending on Windows) is
   * treated as transient — untracking would discard the byte offset and replay
   * the startup tail as duplicate events on re-discovery.
   */
  private handleStatFailure(state: FileState, err: unknown): void {
    if (errCode(err) === 'ENOENT') {
      this.untrack(state);
      return;
    }
    state.statFailures += 1;
    if (state.statFailures >= STAT_FAILURE_UNTRACK_AFTER) {
      console.warn(
        `[rts-agents] cannot stat ${state.path} (${errCode(err)}) after ` +
          `${state.statFailures} attempts — untracking session ${state.sessionId.slice(0, 8)}`
      );
      this.untrack(state);
    }
  }

  // ── tailing ────────────────────────────────────────────────────────────────

  private trackFile(abs: string, installDir: string, projectDir: string): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    const sessionId = path.basename(abs, '.jsonl');
    const state: FileState = {
      path: abs,
      sessionId,
      installDir,
      projectDir,
      offset: 0,
      size: 0,
      mtimeMs: st.mtimeMs,
      parser: new SessionParser(sessionId.slice(0, 8)),
      debounce: null,
      skipToNewline: false,
      statFailures: 0,
      readFailures: 0,
      tailed: true,
    };
    this.files.set(abs, state);

    const fresh = Date.now() - st.mtimeMs <= STARTUP_LOOKBACK_MS || this.liveSessionIds.has(sessionId);
    if (!fresh) {
      // Old session: skip existing content, only tail future appends.
      state.offset = st.size;
      state.size = st.size;
      state.tailed = false;
      return;
    }
    if (st.size > STARTUP_TAIL_BYTES) {
      // Start mid-file: discard everything before the first newline.
      state.offset = st.size - STARTUP_TAIL_BYTES;
      state.skipToNewline = true;
    }
    this.readAppended(state);
  }

  private scheduleRead(state: FileState): void {
    if (state.debounce !== null) return; // coalesce bursts
    state.debounce = setTimeout(() => {
      state.debounce = null;
      this.readAppended(state);
    }, READ_DEBOUNCE_MS);
  }

  private readAppended(state: FileState): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(state.path);
    } catch (err) {
      this.handleStatFailure(state, err); // ENOENT untracks; else transient
      return;
    }
    state.statFailures = 0;
    state.mtimeMs = st.mtimeMs;

    if (st.size < state.offset) {
      // File shrank (truncated/rewritten): start over.
      state.offset = 0;
      state.size = 0;
      state.skipToNewline = false;
      state.parser.reset();
    }
    if (st.size === state.offset) {
      state.size = st.size;
      return;
    }

    const length = st.size - state.offset;
    let data: Buffer;
    try {
      const fd = fs.openSync(state.path, 'r');
      try {
        const buf = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const n = fs.readSync(fd, buf, read, length - read, state.offset + read);
          if (n <= 0) break;
          read += n;
        }
        data = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      // Retry comes free (size not updated → next poll re-schedules the read),
      // but a persistent failure must not be silent: the agent would drift to a
      // false "idle" while its session is still running.
      state.readFailures += 1;
      if (state.readFailures === 1 || state.readFailures === 10) {
        console.warn(
          `[rts-agents] cannot read ${state.path} (${errCode(err)})` +
            (state.readFailures > 1 ? ` — ${state.readFailures} consecutive failures;` : ' —') +
            ` session ${state.sessionId.slice(0, 8)} may show stale status`
        );
      }
      return;
    }
    state.readFailures = 0;
    state.size = st.size;

    let base = state.offset;
    if (state.skipToNewline) {
      const firstNl = data.indexOf(NEWLINE);
      if (firstNl === -1) return; // no full line yet — keep waiting
      data = data.subarray(firstNl + 1);
      base += firstNl + 1;
      state.skipToNewline = false;
      // Commit the skipped prefix immediately: if the rest of this window holds
      // no newline we return below, and a re-read from the old offset would feed
      // the partial first line to the parser with the skip flag already cleared.
      state.offset = base;
    }

    // Only consume up to the last newline so the offset always sits on a line
    // boundary (also avoids splitting multi-byte UTF-8 sequences mid-char).
    const lastNl = data.lastIndexOf(NEWLINE);
    if (lastNl === -1) return; // partial line only — re-read once more arrives
    const complete = data.subarray(0, lastNl + 1);
    state.offset = base + lastNl + 1;

    const updates = state.parser.feed(complete.toString('utf8'));
    if (updates.length > 0) {
      this.store.applyUpdates(
        { sessionId: state.sessionId, installDir: state.installDir, projectDir: state.projectDir },
        updates
      );
    }
  }

  private untrack(state: FileState): void {
    if (state.debounce !== null) clearTimeout(state.debounce);
    state.debounce = null;
    this.files.delete(state.path);
  }

  private closeQuietly(watcher: fs.FSWatcher | null): void {
    try {
      watcher?.close();
    } catch {
      // already closed
    }
  }
}
