// Right-side terminal drawer: resizable (width remembered) or Focus mode (fills
// the main area), a tab strip of pty-backed xterm terminals (desktop app) or
// parchment notices (browser), the quest chooser for building clicks and
// "Create Party", and the "Go to terminal" card for heroes running elsewhere.
// Desktop: tabs are saved on every change and come back asleep after a restart.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { AgentState, NamesResponse, RallySession, ReviewVerdict } from '../types/agent';
import { serverHttpUrl } from '../hooks/useAgentSocket';
import type { DesktopBridge, FocusSessionResult } from '../types/desktop';
import type { FocusRequest } from './Village';
import { TAVERN_PLACE, allPlaces, resolveAgentPlace } from '../world/registry';
import type { PlaceDef, RepoDef } from '../world/registry';
import { heroColor } from '../utils/spriteMapper';
import {
  FALLBACK_CWD,
  LEADER_NAME,
  isLeader,
  NAMELESS,
  activityLine,
  agentCwd,
  agentName,
  agentPlaceLabel,
  relTime,
  resumeCwd,
  shortPath,
  squireName,
  terminalTitles,
} from '../utils/agentLabel';
import { epithetOf, epithetTitle } from '../utils/epithet';
import { flavorLine } from '../utils/flavor';
import {
  TABS_STORAGE_KEY,
  cwdForProject,
  makeTab,
  parsePersistedTabs,
  restoreTabs,
  snapshotTabs,
} from '../utils/terminalTabs';
import type { BlockedMap, BlockedMark, PersistedTabs, SleepingHero, TerminalTab } from '../utils/terminalTabs';
import { BLOCKED_NOTE_MAX } from '../utils/terminalTabs';
import { DRAWER_DEFAULT_RATIO, clampDrawerWidth } from '../hooks/useDrawerWidth';
import XtermView from './XtermView';
import TerminalNotice, { MissingHistoryNotice } from './TerminalNotice';
import { Portrait } from './Portrait';
import { StatusPill } from './PartyBar';
import './TerminalPanel.css';

export interface PlaceRequest {
  /** Null = "Create Party": pick any place. */
  placeId: string | null;
  repoId: string | null;
  nonce: number;
}

/** "Rally the party": resume these sessions, each in its own tab. */
export interface RallyRequest {
  sessions: RallySession[];
  nonce: number;
}

/** "Move into the village" clicked (or its waiting list cancelled). */
export interface MoveRequest {
  nonce: number;
  cancel?: boolean;
}

/** For the party bar: outside terminals that could move, and how many wait for their turn to end. */
export interface MoveStatus {
  outside: number;
  waiting: number;
  /** The desktop shell can close outside claudes (older shells need a restart). */
  supported: boolean;
  desktop: boolean;
}

/** What a batch resume needs to know about a session. */
interface ResumeSpec {
  sessionId: string;
  name: string | null;
  cwd: string | null;
  rootCwd: string | null;
  isSquire: boolean;
}

function specOf(a: AgentState): ResumeSpec {
  return { sessionId: a.sessionId, name: a.customTitle, cwd: a.cwd, rootCwd: a.rootCwd, isSquire: a.isSquire };
}

/** "Go to terminal" drives Windows windows/tabs only (desktop/src/focus.ts). */
const IS_WINDOWS = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/** Safe to close: Claude is waiting for the user and no background squire is still working. */
function turnOver(a: AgentState): boolean {
  if (a.status === 'delegating') return false;
  if (a.ccStatus !== null) return a.ccStatus === 'idle';
  return a.status === 'done' || a.status === 'idle';
}

/** Gap between rallied claudes starting, so a big rally doesn't spawn them all in one burst. */
const RALLY_STAGGER_MS = 700;

export interface TerminalPanelProps {
  open: boolean;
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
  bridge: DesktopBridge | null;
  agents: AgentState[];
  /** Session picked in the party or the village — focus its tab, show its card, or resume it. */
  sessionRequest: FocusRequest | null;
  /** Building / city clicked — show the quest chooser for that place. */
  placeRequest: PlaceRequest | null;
  /** Focus mode: the drawer fills the main area and the village shrinks to a preview. */
  focusMode: boolean;
  onToggleFocus: () => void;
  /** The first agents snapshot has arrived (restored tabs wait for it before deciding resume vs card). */
  synced: boolean;
  /** A Create Party / Fetch Squire tab was adopted by its new hero (fired once per adoption). */
  onHeroAdopted?: (sessionId: string, launchedAt: number) => void;
  /** Resumed tabs, so the party can keep a card for heroes the server doesn't list (yet). */
  onSleepers?: (sleepers: SleepingHero[]) => void;
  /** Restored drawer-open state from the last run. */
  onRestoreDrawer?: (open: boolean) => void;
  /** Rally card clicked: reopen these sessions (staggered). */
  rallyRequest?: RallyRequest | null;
  /** "Move into the village" clicked. */
  moveRequest?: MoveRequest | null;
  onMoveStatus?: (status: MoveStatus) => void;
  /** Party card ✕ confirmed: end this session (our tab, or the outside claude) and drop it. */
  dismissRequest?: FocusRequest | null;
  /** The terminal on show changed (a session id, `tab:<id>` for a launch not yet adopted, or null). */
  onActiveChange?: (id: string | null) => void;
  /** Blocked labels (UI only), and setting/clearing one (null note = unblock). */
  blocked?: BlockedMap;
  onSetBlocked?: (sessionId: string, note: string | null) => void;
  /** Party Leader: sessions opted in to review, the Leader's latest verdicts, and "recruit" clicks. */
  reviewIds?: string[];
  verdicts?: ReviewVerdict[];
  leaderRequest?: { nonce: number } | null;
  onToggleReview?: (sessionId: string) => void;
  /** Sessions waiting for (or in) a Leader review right now — for the party cards. */
  onReviewQueue?: (ids: string[]) => void;
}

const EMPTY_IDS: string[] = [];
const EMPTY_VERDICTS: ReviewVerdict[] = [];
/** Don't type a new review into the Leader until it has had time to pick up the last one. */
const LEADER_DISPATCH_GAP_MS = 8_000;

/** Past the shell's 3 s close grace (desktop main.ts CLOSE_GRACE_MS) plus exit time. */
const POP_OUT_DELAY_MS = 4500;

/** Party id for a launch tab whose hero hasn't appeared yet. */
export const LAUNCH_PREFIX = 'tab:';

interface Chooser {
  /** Null lists every place (Create Party). */
  place: PlaceDef | null;
  repoId: string | null;
}

interface Toast {
  text: string;
  tone: 'ok' | 'warn' | 'err';
  hint: string | null;
  nonce: number;
}

const TOAST_MS = 4500;

/** The tab that *is* this hero — a resumed session (launches become one once their hero appears). */
function tabFor(tabs: TerminalTab[], sessionId: string): TerminalTab | null {
  return tabs.find((t) => t.kind === 'resume' && t.sessionId === sessionId) ?? null;
}

/** Frame colour for a tab not yet linked to a hero — never a borrowed repo/parent colour. */
const NEUTRAL_TAB = '#6b7280';

/** A tab's name/colour/look, read live from its linked hero; the stored copy only until one is linked. */
function liveView(t: TerminalTab, agents: AgentState[]): { name: string; color: string; squire: boolean } {
  const hero = t.kind === 'resume' && t.sessionId ? agents.find((a) => a.sessionId === t.sessionId) : undefined;
  if (hero) return { name: agentName(hero), color: heroColor(hero.sessionId), squire: hero.isSquire };
  return { name: t.name, color: t.kind === 'resume' && t.sessionId ? heroColor(t.sessionId) : NEUTRAL_TAB, squire: t.squire };
}

/** Windows paths from different sources differ in case and slashes only. */
/** The fresher of two saved drawers (localStorage vs the desktop's own copy). */
function newerSave(a: PersistedTabs | null, b: PersistedTabs | null): PersistedTabs | null {
  if (!a) return b;
  if (!b) return a;
  return b.savedAt > a.savedAt ? b : a;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Does this newly seen hero come from this launch tab? (fork → its squire; new → a Nameless in that folder) */
function launchedBy(tab: TerminalTab, a: AgentState): boolean {
  if (tab.kind === 'fork') return a.isSquire && (a.squireOf === tab.sessionId || a.customTitle === tab.name);
  if (tab.kind === 'new') return !a.isSquire && a.customTitle === NAMELESS && sameDir(agentCwd(a), tab.cwd);
  return false;
}

/** Places without repos (the tavern) still get one launch option: the coding root. */
function launchTargets(place: PlaceDef): RepoDef[] {
  if (place.repos.length > 0) return place.repos;
  return [{ id: place.id, name: place.name, match: [], cwd: FALLBACK_CWD }];
}

/** WT tab titles carry Claude's spinner glyph ("✳ FAT-340") — drop it for display. */
function bareTitle(t: string): string {
  return t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

/** What the "Go to terminal" result means for the user, one line. */
function focusToast(r: FocusSessionResult): Omit<Toast, 'nonce'> {
  const app = r.app ?? 'its terminal';
  if (r.ok && r.foreground) {
    if (r.method === 'wt-tab') return { tone: 'ok', text: `Opened in ${app} ✓`, hint: r.tab ? `Tab “${bareTitle(r.tab)}”` : null };
    if (app === 'Windows Terminal') {
      return { tone: 'warn', text: `Opened ${app} — pick the tab yourself`, hint: r.detail || null };
    }
    return { tone: 'ok', text: `Opened in ${app} ✓`, hint: r.window };
  }
  if (r.ok) {
    return { tone: 'warn', text: `Found it in ${app}, but Windows kept focus here`, hint: 'Click it in the taskbar.' };
  }
  if (r.method === 'pid-gone') return { tone: 'warn', text: 'That session just ended', hint: 'Resume it here instead.' };
  if (r.method === 'not-found') {
    return { tone: 'err', text: "Couldn't find its terminal window", hint: 'It may be running headless or minimised to a service.' };
  }
  return { tone: 'err', text: "Couldn't switch to its terminal", hint: r.detail || null };
}

export default function TerminalPanel(props: TerminalPanelProps) {
  const { open, width, onWidthChange, onClose, bridge, agents, sessionRequest, placeRequest, focusMode, onToggleFocus } = props;
  const { synced, onHeroAdopted, onSleepers, onRestoreDrawer, rallyRequest, moveRequest, onMoveStatus } = props;
  const { dismissRequest, onActiveChange, blocked = {}, onSetBlocked } = props;
  const { reviewIds = EMPTY_IDS, verdicts = EMPTY_VERDICTS, leaderRequest = null, onToggleReview, onReviewQueue } = props;
  const cbs = useRef({ onHeroAdopted, onSleepers, onRestoreDrawer, onMoveStatus, onActiveChange });
  cbs.current = { onHeroAdopted, onSleepers, onRestoreDrawer, onMoveStatus, onActiveChange };

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  /** Session shown as a "running elsewhere" card instead of a terminal. */
  const [cardId, setCardId] = useState<string | null>(null);
  const [focusBusy, setFocusBusy] = useState<string | null>(null);
  const [lastFocus, setLastFocus] = useState<{ sessionId: string; result: FocusSessionResult } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  /** When each session first showed up here (the opening snapshot counts as "always been there"). */
  const firstSeen = useRef<Map<string, number> | null>(null);
  /** tab id → pid of the claude we spawned for it; how we tell our own sessions from external ones. */
  const tabPids = useRef(new Map<string, number>());
  /** Outside claudes "Move into the village" closed — the server may list them as alive for a few more seconds. */
  const releasedPids = useRef(new Set<number>());
  /** Sessions whose transcript lookup is in flight (stops a double click opening two tabs). */
  const pendingOpen = useRef(new Set<string>());
  const toastTimer = useRef<number | undefined>(undefined);
  /** Bumped by every tab focus, so re-clicking a still-sleeping tab retries its wake. */
  const [wakeNonce, setWakeNonce] = useState(0);
  /** Restored tabs whose wake (transcript lookup) is in flight. */
  const waking = useRef(new Set<string>());
  /** Saving starts only once the last run's tabs are back (else the empty start would erase them). */
  const [restoreReady, setRestoreReady] = useState(false);
  const restoreDone = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((t: Omit<Toast, 'nonce'>): void => {
    setToast({ ...t, nonce: Date.now() });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const addTab = useCallback((init: Omit<TerminalTab, 'id' | 'createdAt'>): void => {
    const tab = makeTab(init);
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
    setChooser(null);
    setCardId(null);
  }, []);

  const focusTab = useCallback((id: string): void => {
    setActiveId(id);
    setChooser(null);
    setCardId(null);
    setWakeNonce((n) => n + 1);
  }, []);

  /** Our tab whose spawned claude has this pid (a launch tab not yet adopted counts too). */
  const ownTabForPid = useCallback((pid: number): TerminalTab | null => {
    for (const t of tabsRef.current) if (tabPids.current.get(t.id) === pid) return t;
    return null;
  }, []);

  /**
   * Start a restored tab's pty: a known session resumes from its transcript's folder (or shows the
   * missing-history parchment); one running elsewhere shows the "Go to terminal" card unless forced.
   */
  const wakeTab = useCallback(
    async (id: string, force: boolean): Promise<void> => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t?.restored || waking.current.has(id)) return;
      let patch: Partial<TerminalTab>;
      if (t.kind === 'resume' && t.sessionId) {
        const sid = t.sessionId;
        const a = agentsRef.current.find((x) => x.sessionId === sid);
        const pid = a && a.alive && a.pid !== null ? a.pid : null;
        const elsewhere = pid !== null && !ownTabForPid(pid) && !releasedPids.current.has(pid);
        if (elsewhere && !force) {
          setCardId(sid);
          setChooser(null);
          return;
        }
        waking.current.add(id);
        let cwd = t.cwd;
        let missing = false;
        try {
          if (bridge?.findTranscript) {
            const r = await bridge.findTranscript(sid);
            if (!r.found) missing = true;
            else if (r.projectDir) cwd = cwdForProject([t.rootCwd ?? null, t.cwd], r.projectDir) ?? cwd;
          }
        } catch {
          // lookup failed — resume from the saved dir; the stream detector still catches a miss
        } finally {
          waking.current.delete(id);
        }
        patch = { restored: false, cwd, missing, elsewherePid: elsewhere ? pid : null };
      } else {
        // A relaunch: only heroes that appear from now on may adopt it.
        patch = { restored: false, createdAt: Date.now() };
      }
      setTabs((cur) => cur.map((x) => (x.id === id && x.restored ? { ...x, ...patch } : x)));
    },
    [bridge, ownTabForPid],
  );

  /** `claude --resume` in-app, from the folder its transcript is filed under (pre-checked on disk). */
  const resumeHere = useCallback(
    async (a: AgentState, elsewherePid: number | null): Promise<void> => {
      const id = a.sessionId;
      // A restored tab for this hero: wake it in place (the user chose Resume / Take over).
      const sleeping = tabFor(tabsRef.current, id);
      if (sleeping?.restored) {
        setActiveId(sleeping.id);
        setChooser(null);
        setCardId(null);
        void wakeTab(sleeping.id, true);
        return;
      }
      if (pendingOpen.current.has(id)) return;
      pendingOpen.current.add(id);
      let cwd = resumeCwd(a);
      let missing = false;
      try {
        if (bridge?.findTranscript) {
          const r = await bridge.findTranscript(id);
          if (!r.found) missing = true;
          else if (r.projectDir) cwd = cwdForProject([a.rootCwd, a.cwd], r.projectDir) ?? cwd;
        }
      } catch {
        // lookup failed — try the launch dir and let the stream detector catch a miss
      } finally {
        pendingOpen.current.delete(id);
      }
      const existing = tabFor(tabsRef.current, id);
      if (existing) {
        focusTab(existing.id);
        return;
      }
      addTab({
        kind: 'resume',
        sessionId: id,
        name: agentName(a),
        shortId: a.shortId,
        cwd,
        rootCwd: a.rootCwd,
        color: heroColor(id),
        squire: a.isSquire,
        elsewherePid,
        missing,
      });
    },
    [addTab, bridge, focusTab, wakeTab],
  );

  /** Party / village pick: our tab if we have one; a "Go to terminal" card if it runs elsewhere; else resume here. */
  const openSession = useCallback(
    (sessionId: string): void => {
      if (sessionId.startsWith(LAUNCH_PREFIX)) {
        const launch = tabsRef.current.find((t) => t.id === sessionId.slice(LAUNCH_PREFIX.length));
        if (launch) focusTab(launch.id);
        return;
      }
      const existing = tabFor(tabsRef.current, sessionId);
      if (existing) {
        focusTab(existing.id);
        return;
      }
      const a = agentsRef.current.find((x) => x.sessionId === sessionId);
      if (!a) return;
      const own = a.pid !== null ? ownTabForPid(a.pid) : null;
      if (own) {
        focusTab(own.id);
        return;
      }
      if (a.alive && a.pid !== null) {
        setCardId(sessionId);
        setChooser(null);
        return;
      }
      void resumeHere(a, null);
    },
    [focusTab, ownTabForPid, resumeHere],
  );

  /** "Take over here": a second claude on a session that is still running in another terminal. */
  const takeOver = useCallback(
    (a: AgentState): void => {
      void resumeHere(a, a.alive ? a.pid : null);
    },
    [resumeHere],
  );

  const goToTerminal = useCallback(
    async (a: AgentState, pid: number | null = a.pid): Promise<void> => {
      if (!bridge?.focusSession || pid === null) return;
      setFocusBusy(a.sessionId);
      try {
        const result = await bridge.focusSession({ pid, titles: terminalTitles(a) });
        setLastFocus({ sessionId: a.sessionId, result });
        showToast(focusToast(result));
      } catch (err) {
        showToast({ tone: 'err', text: "Couldn't switch to its terminal", hint: err instanceof Error ? err.message : null });
      } finally {
        setFocusBusy(null);
      }
    },
    [bridge, showToast],
  );

  const newSessionIn = useCallback(
    (cwd: string, color: string): void => {
      addTab({ kind: 'new', sessionId: null, name: NAMELESS, shortId: null, cwd, color, squire: false, elsewherePid: null });
    },
    [addTab],
  );

  /** Fork the hero of a resumed tab: same context, new session, named "Squire of <hero>". */
  const fetchSquire = useCallback(
    (parent: TerminalTab): void => {
      if (parent.kind !== 'resume' || !parent.sessionId) return;
      addTab({
        kind: 'fork',
        sessionId: parent.sessionId,
        name: squireName(liveView(parent, agentsRef.current).name),
        shortId: null,
        cwd: parent.cwd,
        color: NEUTRAL_TAB,
        squire: true,
        elsewherePid: null,
      });
    },
    [addTab],
  );

  const closeTab = useCallback((id: string): void => {
    const t = tabsRef.current;
    const idx = t.findIndex((x) => x.id === id);
    const next = t.filter((x) => x.id !== id);
    tabPids.current.delete(id);
    setTabs(next);
    setActiveId((cur) => (cur === id ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : cur));
  }, []);

  /** Swap a dead resume (no transcript) for a fresh session in the same folder, in place. */
  const replaceWithNew = useCallback((id: string): void => {
    const old = tabsRef.current.find((t) => t.id === id);
    if (!old) return;
    const fresh = makeTab({
      kind: 'new',
      sessionId: null,
      name: NAMELESS,
      shortId: null,
      cwd: old.cwd,
      color: old.color,
      squire: false,
      elsewherePid: null,
    });
    tabPids.current.delete(id);
    setTabs((t) => t.map((x) => (x.id === id ? fresh : x)));
    setActiveId(fresh.id);
  }, []);

  const markMissing = useCallback((id: string): void => {
    tabPids.current.delete(id);
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, missing: true } : x)));
  }, []);

  const setTabPid = useCallback((id: string, pid: number | null): void => {
    if (pid === null) tabPids.current.delete(id);
    else tabPids.current.set(id, pid);
  }, []);

  const dismissWarning = useCallback((id: string): void => {
    setTabs((t) => t.map((x) => (x.id === id ? { ...x, elsewherePid: null } : x)));
  }, []);

  useEffect(() => {
    if (!sessionRequest) return;
    openSession(sessionRequest.sessionId);
  }, [sessionRequest, openSession]);

  // ── Batch resume (Rally, Move into the village) ─────────────────────────────
  // Each session gets a resume tab born asleep (an existing asleep one is reused), then wakes on
  // its own slot RALLY_STAGGER_MS apart — also across separate calls, so claudes never start in a burst.
  const wakeTimers = useRef<number[]>([]);
  const nextWakeAt = useRef(0);
  useEffect(() => () => wakeTimers.current.forEach((t) => window.clearTimeout(t)), []);
  const resumeBatch = useCallback(
    (specs: ResumeSpec[], opts: { skipAlive: boolean; focus: boolean }): number => {
      const toWake: string[] = [];
      const added: TerminalTab[] = [];
      for (const s of specs) {
        const a = agentsRef.current.find((x) => x.sessionId === s.sessionId);
        if (opts.skipAlive && a?.alive) continue;
        const existing = tabFor([...tabsRef.current, ...added], s.sessionId);
        if (existing) {
          if (existing.restored && !toWake.includes(existing.id)) toWake.push(existing.id);
          continue;
        }
        const tab: TerminalTab = {
          ...makeTab({
            kind: 'resume',
            sessionId: s.sessionId,
            name: s.name?.trim() || NAMELESS,
            shortId: s.sessionId.slice(0, 8),
            cwd: s.rootCwd ?? s.cwd ?? FALLBACK_CWD,
            rootCwd: s.rootCwd,
            color: heroColor(s.sessionId),
            squire: s.isSquire,
            elsewherePid: null,
          }),
          restored: true,
        };
        added.push(tab);
        toWake.push(tab.id);
      }
      if (added.length > 0) {
        tabsRef.current = [...tabsRef.current, ...added];
        setTabs((cur) => [...cur, ...added]);
      }
      if (toWake.length > 0 && opts.focus) {
        setActiveId(toWake[0] ?? null);
        setChooser(null);
        setCardId(null);
      }
      for (const id of toWake) {
        const at = Math.max(Date.now(), nextWakeAt.current);
        nextWakeAt.current = at + RALLY_STAGGER_MS;
        wakeTimers.current.push(window.setTimeout(() => void wakeTab(id, true), at - Date.now()));
      }
      return toWake.length;
    },
    [wakeTab],
  );

  // Rally: reopen sessions a power cut / restart killed. Ones already running are skipped.
  const handledRallyRef = useRef<RallyRequest | null>(null);
  useEffect(() => {
    if (!rallyRequest || handledRallyRef.current === rallyRequest) return;
    handledRallyRef.current = rallyRequest;
    const n = resumeBatch(rallyRequest.sessions, { skipAlive: true, focus: true });
    if (n === 0) {
      showToast({ tone: 'warn', text: 'Nothing to rally', hint: 'Those heroes are already running.' });
      return;
    }
    showToast({ tone: 'ok', text: `Rallying ${n} ${n === 1 ? 'hero' : 'heroes'}…`, hint: 'Each resumes in its own tab.' });
  }, [rallyRequest, resumeBatch, showToast]);

  // ── Move into the village ───────────────────────────────────────────────────
  // Sessions running in outside terminals are closed there (verified claude pid) and resumed here.
  // One mid-turn is never interrupted: it waits, and moves the moment its turn ends.
  const [waiting, setWaiting] = useState<string[]>([]);
  const moving = useRef(new Set<string>());
  // The preload is re-read on every page reload, the main process only on an app restart — so the
  // bridge can offer releaseSession while main has no handler yet. Probe with a call main rejects
  // before touching anything (pid 0); "No handler registered" means a restart is needed.
  const [releaseReady, setReleaseReady] = useState(false);
  useEffect(() => {
    const release = bridge?.releaseSession;
    if (!release) {
      setReleaseReady(false);
      return;
    }
    let live = true;
    release({ pid: 0, sessionId: '' }).then(
      () => live && setReleaseReady(true),
      () => live && setReleaseReady(false),
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const isOwnPid = useCallback((pid: number): boolean => [...tabPids.current.values()].includes(pid), []);
  const outsiders = useCallback(
    (): AgentState[] =>
      agentsRef.current.filter(
        (a) =>
          a.alive &&
          a.pid !== null &&
          !isOwnPid(a.pid) &&
          !releasedPids.current.has(a.pid) &&
          (a.eventCount > 0 || a.title !== null),
      ),
    [isOwnPid],
  );

  const moveOne = useCallback(
    async (a: AgentState): Promise<boolean> => {
      const release = bridge?.releaseSession;
      if (!release || !releaseReady || a.pid === null || moving.current.has(a.sessionId)) return false;
      moving.current.add(a.sessionId);
      try {
        const r = await release({ pid: a.pid, sessionId: a.sessionId });
        if (!r.ok) {
          showToast({ tone: 'err', text: `Couldn't move ${agentName(a)}`, hint: r.detail });
          return false;
        }
        releasedPids.current.add(a.pid);
        resumeBatch([specOf(a)], { skipAlive: false, focus: false });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/No handler registered/i.test(msg)) {
          setReleaseReady(false);
          showToast({ tone: 'warn', text: 'Restart the app to finish installing Move', hint: 'The desktop shell is older than the dashboard.' });
        } else {
          showToast({ tone: 'err', text: `Couldn't move ${agentName(a)}`, hint: msg });
        }
        return false;
      } finally {
        moving.current.delete(a.sessionId);
      }
    },
    [bridge, releaseReady, resumeBatch, showToast],
  );

  /** The card's "Move here": close this one outside claude and resume it here (after its turn, if mid-turn). */
  const moveHere = useCallback(
    (a: AgentState): void => {
      setCardId(null);
      if (!turnOver(a)) {
        setWaiting((cur) => (cur.includes(a.sessionId) ? cur : [...cur, a.sessionId]));
        showToast({ tone: 'ok', text: `${agentName(a)} moves here when its turn ends`, hint: null });
        return;
      }
      void moveOne(a).then((ok) => {
        const tab = ok ? tabFor(tabsRef.current, a.sessionId) : null;
        if (tab) focusTab(tab.id);
      });
    },
    [moveOne, focusTab, showToast],
  );

  /**
   * "Pop out": end this tab's claude and resume the session in the OS terminal, so a village
   * restart can't take it down. Mid-turn sessions are refused (closing would cut the turn off).
   */
  const popOut = useCallback(
    (t: TerminalTab): void => {
      const pop = bridge?.popOutSession;
      const sid = t.kind === 'resume' ? t.sessionId : null;
      if (!pop || !sid) return;
      const a = agentsRef.current.find((x) => x.sessionId === sid);
      if (a && a.alive && !turnOver(a)) {
        showToast({ tone: 'warn', text: `${agentName(a)} is mid-turn`, hint: 'Pop it out when its turn ends.' });
        return;
      }
      closeTab(t.id);
      // The shell ends a closed tab's claude after a 3 s grace (reload safety); wait past it so the
      // outside claude never shares the session with the village's.
      showToast({ tone: 'ok', text: `Popping out ${t.name}…`, hint: 'Opening it in a terminal window in a few seconds.' });
      window.setTimeout(() => {
        pop({ sessionId: sid, cwd: t.cwd })
          .then((r) =>
            showToast(
              r.ok
                ? { tone: 'ok', text: `${t.name} popped out ✓`, hint: `${r.detail} — Move here brings it back.` }
                : { tone: 'err', text: `Couldn't pop out ${t.name}`, hint: r.detail },
            ),
          )
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            showToast({
              tone: 'err',
              text: `Couldn't pop out ${t.name}`,
              hint: /No handler registered/i.test(msg) ? 'Restart the app once (↻) to finish installing Pop out.' : msg,
            });
          });
      }, POP_OUT_DELAY_MS);
    },
    [bridge, closeTab, showToast],
  );

  /** Party ✕: end the session — our tab's claude, or the outside one (verified) — and forget its tab. */
  const handledDismiss = useRef<FocusRequest | null>(null);
  useEffect(() => {
    if (!dismissRequest || handledDismiss.current === dismissRequest) return;
    handledDismiss.current = dismissRequest;
    const id = dismissRequest.sessionId;
    if (cardId === id) setCardId(null);
    const tab = id.startsWith(LAUNCH_PREFIX)
      ? tabsRef.current.find((t) => t.id === id.slice(LAUNCH_PREFIX.length))
      : tabFor(tabsRef.current, id);
    if (tab) {
      closeTab(tab.id);
      return;
    }
    const a = agentsRef.current.find((x) => x.sessionId === id);
    const release = bridge?.releaseSession;
    if (!a || !a.alive || a.pid === null || !release) return;
    const pid = a.pid;
    release({ pid, sessionId: id })
      .then((r) => {
        if (r.ok) releasedPids.current.add(pid);
        else showToast({ tone: 'err', text: `Couldn't end ${agentName(a)}`, hint: r.detail });
      })
      .catch((err: unknown) =>
        showToast({ tone: 'err', text: `Couldn't end ${agentName(a)}`, hint: err instanceof Error ? err.message : String(err) }),
      );
  }, [dismissRequest, cardId, bridge, closeTab, showToast]);

  // ── Party Leader ───────────────────────────────────────────────────────────
  // "Recruit": a fresh session named PARTY LEADER in the coding root.
  const writers = useRef(new Map<string, (data: string) => void>());
  const handledLeaderReq = useRef<{ nonce: number } | null>(null);
  useEffect(() => {
    if (!leaderRequest || handledLeaderReq.current === leaderRequest) return;
    handledLeaderReq.current = leaderRequest;
    addTab({ kind: 'new', sessionId: null, name: LEADER_NAME, shortId: null, cwd: FALLBACK_CWD, color: NEUTRAL_TAB, squire: false, elsewherePid: null });
  }, [leaderRequest, addTab]);

  // Review queue: an opted-in party that finishes a turn is queued once per finished turn; the
  // queue is typed into the Leader's terminal one at a time, whenever the Leader is idle.
  const reviewQueue = useRef<string[]>([]);
  const reviewedAt = useRef(new Map<string, number>());
  const lastDispatch = useRef<{ at: number; sessionId: string | null }>({ at: 0, sessionId: null });
  const leaderMissingWarned = useRef(false);
  const queueKey = useRef('');
  useEffect(() => {
    const enabled = new Set(reviewIds);
    const leader = agents.find((a) => a.alive && isLeader(a)) ?? null;
    // 1. queue finished turns
    for (const a of agents) {
      if (!enabled.has(a.sessionId) || isLeader(a) || a.isSquire || !a.alive) continue;
      const finished = (a.status === 'done' || a.ccStatus === 'idle') && a.status !== 'delegating';
      if (!finished || (reviewedAt.current.get(a.sessionId) ?? 0) >= a.lastEventAt) continue;
      reviewedAt.current.set(a.sessionId, a.lastEventAt);
      if (!reviewQueue.current.includes(a.sessionId)) reviewQueue.current.push(a.sessionId);
    }
    reviewQueue.current = reviewQueue.current.filter((id) => enabled.has(id));
    // 2. dispatch to an idle Leader that runs in a village tab
    const now = Date.now();
    const next = reviewQueue.current[0];
    if (next && leader) {
      const tab = tabFor(tabsRef.current, leader.sessionId) ?? (leader.pid !== null ? ownTabForPid(leader.pid) : null);
      const write = tab ? writers.current.get(tab.id) : undefined;
      const leaderIdle = leader.ccStatus === 'idle' || (leader.ccStatus === null && (leader.status === 'done' || leader.status === 'idle'));
      if (!write) {
        if (!leaderMissingWarned.current) {
          leaderMissingWarned.current = true;
          showToast({ tone: 'warn', text: 'Party Leader is not in the village', hint: 'Reviews wait until its terminal is open here.' });
        }
      } else if (leaderIdle && now - lastDispatch.current.at > LEADER_DISPATCH_GAP_MS) {
        leaderMissingWarned.current = false;
        const worker = agents.find((a) => a.sessionId === next);
        const last = verdicts.find((v) => v.sessionId === next);
        const round = last && last.verdict === 'changes' ? last.round + 1 : 1;
        reviewQueue.current.shift();
        lastDispatch.current = { at: now, sessionId: next };
        if (worker) {
          const payload = JSON.stringify({ name: agentName(worker), session: worker.sessionId, cwd: worker.cwd ?? worker.rootCwd ?? FALLBACK_CWD, round });
          write(`/party-leader review ${payload}`);
          // Submit separately so the slash-command menu has settled on the typed text.
          window.setTimeout(() => write('\r'), 400);
        }
      }
    }
    // 3. tell the party which cards are waiting / in review
    // In review = dispatched, Leader still busy, and no verdict recorded since the dispatch.
    const sent = lastDispatch.current;
    const answered = sent.sessionId !== null && verdicts.some((v) => v.sessionId === sent.sessionId && v.at >= sent.at);
    const inReview = sent.sessionId && leader && leader.ccStatus !== 'idle' && !answered ? [sent.sessionId] : [];
    const ids = [...new Set([...inReview, ...reviewQueue.current])];
    const key = ids.join('|');
    if (key !== queueKey.current) {
      queueKey.current = key;
      onReviewQueue?.(ids);
    }
  }, [agents, reviewIds, verdicts, ownTabForPid, showToast, onReviewQueue]);

  const handledMoveRef = useRef<MoveRequest | null>(null);
  useEffect(() => {
    if (!moveRequest || handledMoveRef.current === moveRequest) return;
    handledMoveRef.current = moveRequest;
    if (moveRequest.cancel) {
      setWaiting([]);
      return;
    }
    const list = outsiders();
    const ready = list.filter(turnOver);
    const busy = list.filter((a) => !turnOver(a)).map((a) => a.sessionId);
    setWaiting((cur) => [...new Set([...cur, ...busy])]);
    void (async () => {
      let moved = 0;
      // One at a time: each outside claude must be gone before its session resumes here.
      for (const a of ready) if (await moveOne(a)) moved += 1;
      const first = ready[0] ? tabFor(tabsRef.current, ready[0].sessionId) : null;
      if (first) focusTab(first.id);
      const n = busy.length;
      const later = n > 0 ? `${n} mid-turn ${n === 1 ? 'session moves when its' : 'sessions move when their'} turn ends.` : null;
      if (moved > 0) showToast({ tone: 'ok', text: `Moved ${moved} into the village ✓`, hint: later });
      else if (later) showToast({ tone: 'ok', text: 'Waiting for turns to end…', hint: later });
      else if (list.length === 0) showToast({ tone: 'warn', text: 'No outside terminals to move', hint: null });
    })();
  }, [moveRequest, outsiders, moveOne, focusTab, showToast]);

  // A waiting session moves as soon as its turn ends; one that exits on its own is dropped.
  useEffect(() => {
    if (waiting.length === 0) return;
    const still: string[] = [];
    for (const id of waiting) {
      const a = agents.find((x) => x.sessionId === id);
      if (!a || !a.alive || a.pid === null || isOwnPid(a.pid) || releasedPids.current.has(a.pid)) continue;
      if (turnOver(a)) void moveOne(a);
      else still.push(id);
    }
    if (still.length !== waiting.length) setWaiting(still);
  }, [agents, waiting, moveOne, isOwnPid]);

  // Tell the party bar how many outside terminals there are (and how many are waiting to move).
  const moveKey = useRef('');
  useEffect(() => {
    const status: MoveStatus = {
      outside: outsiders().length,
      waiting: waiting.length,
      supported: releaseReady,
      desktop: !!bridge,
    };
    const key = JSON.stringify(status);
    if (key === moveKey.current) return;
    moveKey.current = key;
    cbs.current.onMoveStatus?.(status);
  }, [agents, tabs, waiting, bridge, outsiders, releaseReady]);

  // Each place request (one click) is handled once, even if the effect re-runs.
  const handledPlaceRef = useRef<PlaceRequest | null>(null);
  useEffect(() => {
    if (!placeRequest || handledPlaceRef.current === placeRequest) return;
    handledPlaceRef.current = placeRequest;
    if (placeRequest.placeId === null) {
      // Create Party: straight to a fresh Nameless terminal in the coding root — pick the
      // project from inside Claude (/resume, cd), not from a chooser.
      setChooser(null);
      setCardId(null);
      newSessionIn(FALLBACK_CWD, NEUTRAL_TAB);
      return;
    }
    const place = [...allPlaces(), TAVERN_PLACE].find((p) => p.id === placeRequest.placeId);
    if (place) {
      setChooser({ place, repoId: placeRequest.repoId });
      setCardId(null);
    }
  }, [placeRequest, newSessionIn]);

  // A launch tab ("Nameless" / "Squire of …") becomes its hero's resume tab once the server reports
  // the new session, so a party click focuses this terminal instead of resuming the session twice.
  useEffect(() => {
    const t0 = Date.now();
    let seen = firstSeen.current;
    if (!seen) {
      seen = firstSeen.current = new Map(agents.map((a) => [a.sessionId, -1]));
      return;
    }
    for (const a of agents) if (!seen.has(a.sessionId)) seen.set(a.sessionId, t0);
    const when = seen;
    setTabs((cur) => {
      const bound = new Set(cur.map((t) => (t.kind === 'resume' ? t.sessionId : null)));
      let changed = false;
      const next = cur.map((t) => {
        // Keep the stored name in step with the hero's `/rename`: it is what the tab, the party's
        // sleeper card and the saved drawer show once the hero leaves the roster (asleep / idle-dropped).
        const linked = t.kind === 'resume' && t.sessionId ? agents.find((a) => a.sessionId === t.sessionId) : undefined;
        if (linked?.customTitle?.trim() && agentName(linked) !== t.name) {
          changed = true;
          t = { ...t, name: agentName(linked) };
        }
        // Restored tabs have no process yet — nothing to follow or adopt.
        if (t.restored) return t;
        if (t.kind === 'resume') {
          // `/resume` or `/clear` inside the tab swaps the session under the same claude:
          // follow the process (by pid) so the label, colour and party clicks track it.
          const pid = tabPids.current.get(t.id);
          const now = pid !== undefined ? agents.find((a) => a.pid === pid && a.alive) : undefined;
          if (!now || now.sessionId === t.sessionId || bound.has(now.sessionId)) return t;
          bound.add(now.sessionId);
          changed = true;
          return {
            ...t,
            sessionId: now.sessionId,
            shortId: now.shortId,
            name: agentName(now),
            squire: now.isSquire,
            rootCwd: now.rootCwd,
          };
        }
        // Exact: the session file's pid is the claude we spawned. Fallback: the name/folder heuristic.
        const pid = tabPids.current.get(t.id);
        const hero =
          (pid !== undefined ? agents.find((a) => a.pid === pid && !bound.has(a.sessionId)) : undefined) ??
          agents.find((a) => !bound.has(a.sessionId) && (when.get(a.sessionId) ?? -1) >= t.createdAt && launchedBy(t, a));
        if (!hero) return t;
        bound.add(hero.sessionId);
        changed = true;
        return {
          ...t,
          kind: 'resume' as const,
          sessionId: hero.sessionId,
          shortId: hero.shortId,
          name: agentName(hero),
          color: heroColor(hero.sessionId),
          squire: hero.isSquire,
          rootCwd: hero.rootCwd,
          adoptedAt: t0,
        };
      });
      return changed ? next : cur;
    });
  }, [agents]);

  // Each adoption selects its new hero once (the tab id is remembered, so re-renders never re-fire).
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const t of tabs) {
      if (t.adoptedAt === undefined || !t.sessionId || announced.current.has(t.id)) continue;
      announced.current.add(t.id);
      cbs.current.onHeroAdopted?.(t.sessionId, t.createdAt);
    }
  }, [tabs]);

  /** Restored tabs saved under a stale name (e.g. "Nameless" before a `/rename`): ask the server for the latest. */
  const recoverNames = useCallback(async (restored: TerminalTab[]): Promise<void> => {
    const ids = restored.filter((t) => t.kind === 'resume' && t.sessionId).map((t) => t.sessionId as string);
    if (ids.length === 0) return;
    try {
      const res = await fetch(`${serverHttpUrl()}/api/names?ids=${ids.map(encodeURIComponent).join(',')}`);
      if (!res.ok) return;
      const { names } = (await res.json()) as NamesResponse;
      setTabs((cur) => {
        let changed = false;
        const next = cur.map((t) => {
          const name = t.kind === 'resume' && t.sessionId ? names?.[t.sessionId] : null;
          if (!name || name === t.name) return t;
          changed = true;
          return { ...t, name };
        });
        return changed ? next : cur;
      });
    } catch {
      // server unreachable — keep the saved names
    }
  }, []);

  // ── Restart persistence (desktop only) ─────────────────────────────────────
  // Bring back the last run's tabs asleep; the active one wakes once the roster is in.
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    let local: PersistedTabs | null = null;
    try {
      local = parsePersistedTabs(localStorage.getItem(TABS_STORAGE_KEY));
    } catch {
      // storage blocked — the desktop copy may still have it
    }
    // Terminals that kept running through a reload come back live (they reattach), not asleep.
    const liveKeys: Promise<string[]> = (bridge.pty.live?.() ?? Promise.resolve([])).catch(() => []);
    const apply = (saved: PersistedTabs | null): void => {
      void liveKeys.then((keys) => restore(saved, new Set(keys)));
    };
    const restore = (saved: PersistedTabs | null, running: Set<string>): void => {
      if (!live || restoreDone.current) return;
      restoreDone.current = true;
      if (saved && saved.tabs.length > 0) {
        const back = restoreTabs(saved).map((t) => (running.has(t.id) ? { ...t, restored: false } : t));
        const had = tabsRef.current.length > 0;
        setTabs((cur) => [...back, ...cur.filter((c) => !back.some((b) => b.id === c.id))]);
        void recoverNames(back);
        if (!had) setActiveId((back.find((t) => t.id === saved.activeId) ?? back[0])?.id ?? null);
        cbs.current.onRestoreDrawer?.(saved.drawerOpen);
      }
      setRestoreReady(true);
    };
    const load = bridge.tabState?.load;
    if (!load) apply(local);
    else
      load().then(
        (raw) => apply(newerSave(local, parsePersistedTabs(raw))),
        () => apply(local),
      );
    return () => {
      live = false;
    };
  }, [bridge]);

  // Every change is written at once (localStorage + the desktop's file), so a restart loses nothing.
  const lastSaved = useRef('');
  useEffect(() => {
    if (!bridge || !restoreReady) return;
    const rootOf = (sid: string): string | null => agentsRef.current.find((a) => a.sessionId === sid)?.rootCwd ?? null;
    const snap = snapshotTabs(tabs, activeId, open, rootOf);
    const key = JSON.stringify({ ...snap, savedAt: 0 });
    if (key === lastSaved.current) return;
    lastSaved.current = key;
    const json = JSON.stringify(snap);
    try {
      localStorage.setItem(TABS_STORAGE_KEY, json);
    } catch {
      // storage blocked — the desktop copy still has it
    }
    try {
      bridge.tabState?.save(json);
    } catch {
      // older shell without tabState
    }
  }, [bridge, restoreReady, tabs, activeId, open]);

  // Focusing a restored tab spawns it — at startup only the active one, not a stampede of claudes.
  useEffect(() => {
    if (!synced || !activeId) return;
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.restored) void wakeTab(t.id, false);
  }, [activeId, synced, wakeNonce, wakeTab]);

  // Tell the app which terminal is on show, so the party highlight follows the drawer.
  const shownRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let shown: string | null = null;
    if (cardId) shown = cardId;
    else if (!chooser) {
      const t = tabs.find((x) => x.id === activeId);
      if (t) shown = t.kind === 'resume' && t.sessionId ? t.sessionId : LAUNCH_PREFIX + t.id;
    }
    if (shown === shownRef.current) return;
    shownRef.current = shown;
    if (shown) cbs.current.onActiveChange?.(shown);
  }, [tabs, activeId, cardId, chooser]);

  // Resumed heroes, so the party keeps a placeholder card while the server doesn't list them.
  const sleepersKey = useRef('');
  useEffect(() => {
    const list: SleepingHero[] = [];
    for (const t of tabs) {
      if (t.kind !== 'resume') {
        // No tab strip any more: a launch is reachable from the party until its hero shows up.
        list.push({
          sessionId: LAUNCH_PREFIX + t.id,
          name: t.name,
          cwd: t.cwd,
          rootCwd: t.rootCwd ?? null,
          squire: t.squire,
          asleep: !!t.restored,
          launching: true,
        });
        continue;
      }
      if (!t.sessionId || t.missing) continue;
      list.push({
        sessionId: t.sessionId,
        name: t.name,
        cwd: t.cwd,
        rootCwd: t.rootCwd ?? null,
        squire: t.squire,
        asleep: !!t.restored,
      });
    }
    const key = JSON.stringify(list);
    if (key === sleepersKey.current) return;
    sleepersKey.current = key;
    cbs.current.onSleepers?.(list);
  }, [tabs]);

  // ── Resize handle ──────────────────────────────────────────────────────────
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    const move = (ev: PointerEvent): void => {
      onWidthChange(clampDrawerWidth(window.innerWidth - ev.clientX));
    };
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      setDragging(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    e.preventDefault();
  };

  const card = cardId ? (agents.find((a) => a.sessionId === cardId) ?? null) : null;
  const overlay = chooser !== null || card !== null;
  const active = overlay ? null : (tabs.find((t) => t.id === activeId) ?? null);
  const activeAgent =
    active?.kind === 'resume' && active.sessionId ? (agents.find((a) => a.sessionId === active.sessionId) ?? null) : null;

  const activeView = active ? liveView(active, agents) : null;

  return (
    <aside
      className={`drawer ${open ? '' : 'drawer-closed'} ${dragging ? 'drawer-dragging' : ''} ${focusMode ? 'drawer-focus' : ''}`}
      style={focusMode ? undefined : { width }}
      aria-hidden={!open}
    >
      {!focusMode && (
        <div
          className="drawer-handle"
          onPointerDown={onHandleDown}
          onDoubleClick={() => onWidthChange(window.innerWidth * DRAWER_DEFAULT_RATIO)}
          title="Drag to resize · double-click to reset"
        />
      )}

      {/* One row: what the drawer shows when it isn't a terminal, then the actions. The party on the
          left is the tab list — picking a hero there switches this terminal. */}
      <div className="drawer-strip">
        <span className="drawer-strip-label">
          {chooser ? (
            <>
              <span className="drawer-tab-glyph">✦</span> {chooser.place ? 'New quest' : 'Create party'}
              <button type="button" className="drawer-tab-x" aria-label="Close chooser" onClick={() => setChooser(null)}>
                ×
              </button>
            </>
          ) : card ? (
            <>
              <span className="drawer-tab-glyph">↗</span> {agentName(card)} · running in another terminal
              <button type="button" className="drawer-tab-x" aria-label="Close card" onClick={() => setCardId(null)}>
                ×
              </button>
            </>
          ) : !active ? (
            <span className="drawer-title">Terminals</span>
          ) : null}
        </span>
        <span className="drawer-actions">
          {/* Blocked · Focus · Fetch Squire · Pop out, left to right — Pop out sits top-right, next to hide. */}
          {active && active.kind === 'resume' && active.sessionId && onSetBlocked && (
            <BlockedControl
              key={active.sessionId}
              mark={blocked[active.sessionId] ?? null}
              onSave={(note) => onSetBlocked(active.sessionId as string, note)}
            />
          )}
          {active && active.kind === 'resume' && active.sessionId && onToggleReview && !(activeAgent && isLeader(activeAgent)) && (
            <button
              type="button"
              className={`drawer-btn ${reviewIds.includes(active.sessionId) ? 'drawer-btn-review' : ''}`}
              aria-pressed={reviewIds.includes(active.sessionId)}
              onClick={() => onToggleReview(active.sessionId as string)}
              title={
                reviewIds.includes(active.sessionId)
                  ? 'The Party Leader reviews this party after every finished turn — click to stop'
                  : 'Have the Party Leader review this party after every finished turn'
              }
            >
              👑 {reviewIds.includes(active.sessionId) ? 'Reviewed' : 'Review'}
            </button>
          )}
          {active && (
            <button
              type="button"
              className={`drawer-btn ${focusMode ? 'drawer-btn-on' : ''}`}
              onClick={onToggleFocus}
              aria-pressed={focusMode}
              title={focusMode ? 'Exit focus mode (Ctrl+Shift+F)' : 'Focus mode — terminal fills the screen (Ctrl+Shift+F)'}
            >
              {focusMode ? '⤡ Exit focus' : '⤢ Focus'}
            </button>
          )}
          {active && activeView && active.kind === 'resume' && !active.missing && (
            <button
              type="button"
              className="drawer-btn drawer-btn-squire"
              onClick={() => fetchSquire(active)}
              title={`Fork this session with its context as "${squireName(activeView.name)}"`}
            >
              ⚔ Fetch Squire <span className="drawer-btn-muted">(Fork)</span>
            </button>
          )}
          {active && active.kind === 'resume' && active.sessionId && !active.missing && bridge?.popOutSession && (
            <button
              type="button"
              className="drawer-btn"
              onClick={() => popOut(active)}
              title="Pop out — continue this session in its own terminal window, safe from village restarts"
            >
              ⇱ Pop out
            </button>
          )}
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            title="Hide drawer (Ctrl+` · Esc)"
            aria-label="Hide drawer"
          >
            ×
          </button>
        </span>
      </div>

      {active && active.elsewherePid !== null && !active.missing && (
        <div className="drawer-warn" role="status">
          <span className="drawer-warn-text">
            ⚠ Also running in another terminal — two Claude processes share this session; prompt in one at a time.
          </span>
          {activeAgent && bridge?.focusSession && (
            <button
              type="button"
              className="drawer-warn-go"
              disabled={focusBusy === activeAgent.sessionId}
              onClick={() => void goToTerminal(activeAgent, active.elsewherePid)}
            >
              Go there ↗
            </button>
          )}
          <button
            type="button"
            className="drawer-warn-x"
            aria-label="Dismiss warning"
            onClick={() => dismissWarning(active.id)}
          >
            ×
          </button>
        </div>
      )}

      <div className="drawer-body">
        {tabs.map((t) => {
          const isActive = !overlay && t.id === activeId;
          let pane;
          if (t.missing) {
            pane = <MissingHistoryNotice tab={t} onNewSession={() => replaceWithNew(t.id)} onClose={() => closeTab(t.id)} />;
          } else if (bridge && t.restored) {
            pane = (
              <SleepingPane
                tab={t}
                name={liveView(t, agents).name}
                synced={synced}
                onWake={() => void wakeTab(t.id, true)}
              />
            );
          } else if (bridge) {
            pane = (
              <XtermView
                bridge={bridge}
                tab={t}
                active={isActive && open}
                onPid={(pid) => setTabPid(t.id, pid)}
                onWriter={(w) => {
                  if (w) writers.current.set(t.id, w);
                  else writers.current.delete(t.id);
                }}
                onMissing={() => markMissing(t.id)}
                onClose={() => closeTab(t.id)}
              />
            );
          } else {
            pane = <TerminalNotice tab={t} />;
          }
          return (
            <div key={t.id} className={`drawer-pane ${isActive ? '' : 'drawer-pane-hidden'}`}>
              {pane}
            </div>
          );
        })}

        {card && !chooser && (
          <LiveSessionCard
            agent={card}
            now={now}
            canFocus={!!bridge?.focusSession && IS_WINDOWS}
            onMove={bridge?.releaseSession && releaseReady ? () => moveHere(card) : null}
            busy={focusBusy === card.sessionId}
            last={lastFocus?.sessionId === card.sessionId ? lastFocus.result : null}
            onGo={() => void goToTerminal(card)}
            onTakeOver={() => takeOver(card)}
            onResume={() => void resumeHere(card, null)}
          />
        )}

        {chooser && (
          <PlaceChooser
            chooser={chooser}
            agents={agents}
            hasTabs={tabs.length > 0}
            onLaunch={(repo) => newSessionIn(repo.cwd, NEUTRAL_TAB)}
            onOpen={(a) => openSession(a.sessionId)}
            onBack={() => setChooser(null)}
          />
        )}

        {!overlay && tabs.length === 0 && (
          <div className="drawer-empty">
            <div className="drawer-empty-glyph">▣</div>
            <div className="drawer-empty-title">No terminals open</div>
            <div className="drawer-empty-hint">
              Pick a hero from the party, or click a building to start a quest there.
            </div>
          </div>
        )}

        {toast && (
          <div key={toast.nonce} className={`drawer-toast drawer-toast-${toast.tone}`} role="status">
            <span className="drawer-toast-text">{toast.text}</span>
            {toast.hint && <span className="drawer-toast-hint">{toast.hint}</span>}
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Restored tab, not started yet ────────────────────────────────────────────

interface SleepingPaneProps {
  tab: TerminalTab;
  name: string;
  synced: boolean;
  onWake: () => void;
}

function SleepingPane({ tab, name, synced, onWake }: SleepingPaneProps) {
  return (
    <div className="drawer-sleeping">
      <div className="drawer-sleeping-card">
        <div className="drawer-sleeping-glyph" aria-hidden>
          ↻
        </div>
        <div className="drawer-sleeping-kicker">Restored after a restart</div>
        <div className="drawer-sleeping-title">{name} is asleep in the tavern</div>
        <div className="drawer-sleeping-cwd" title={tab.cwd}>
          {shortPath(tab.cwd)}
        </div>
        <button type="button" className="drawer-btn drawer-btn-primary" onClick={onWake}>
          {tab.kind === 'resume' ? '↻ Wake here' : '✦ Start here'}
        </button>
        {/* Auto-wake waits for the roster (to spot a copy running elsewhere); this button doesn't. */}
        {!synced && <div className="drawer-sleeping-cwd">Waiting for the village roster…</div>}
      </div>
    </div>
  );
}

// ── Blocked label (UI only) ─────────────────────────────────────────────────

/**
 * "⛔ Blocked" toggle for the shown session: a small popover takes an optional note (shown on hover
 * here and on the party card). Purely a reminder — the terminal is never touched.
 */
function BlockedControl({ mark, onSave }: { mark: BlockedMark | null; onSave: (note: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(mark?.note ?? '');
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Node && wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (): void => {
    setDraft(mark?.note ?? '');
    setOpen((v) => !v);
  };
  const save = (): void => {
    onSave(draft);
    setOpen(false);
  };

  return (
    <span className="drawer-blocked" ref={wrapRef}>
      <button
        type="button"
        className={`drawer-btn ${mark ? 'drawer-btn-blocked' : ''}`}
        aria-pressed={!!mark}
        aria-expanded={open}
        onClick={toggle}
        title={mark ? (mark.note ? `Blocked: ${mark.note}` : 'Blocked — no note') : 'Mark this session blocked (a reminder only)'}
      >
        ⛔ {mark ? 'Blocked' : 'Block'}
      </button>
      {open && (
        <div className="drawer-blocked-pop" role="dialog" aria-label={mark ? 'Edit blocked note' : 'Mark blocked'}>
          <label className="drawer-blocked-label" htmlFor="blocked-note">
            What's it waiting on? <span className="drawer-btn-muted">(optional)</span>
          </label>
          <textarea
            id="blocked-note"
            className="drawer-blocked-note"
            value={draft}
            maxLength={BLOCKED_NOTE_MAX}
            rows={3}
            autoFocus
            placeholder="e.g. waiting on Josh's reply about KGH SKUs"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <div className="drawer-blocked-row">
            {mark && (
              <button
                type="button"
                className="drawer-btn drawer-btn-ghost"
                onClick={() => {
                  onSave(null);
                  setOpen(false);
                }}
              >
                Unblock
              </button>
            )}
            <span className="drawer-blocked-spacer" />
            <button type="button" className="drawer-btn drawer-btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="drawer-btn drawer-btn-primary" onClick={save}>
              {mark ? 'Save' : 'Mark blocked'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ── "Running in another terminal" card ─────────────────────────────────────

interface LiveSessionCardProps {
  agent: AgentState;
  now: number;
  /** The desktop bridge can front windows (false in a browser / an older shell). */
  canFocus: boolean;
  busy: boolean;
  last: FocusSessionResult | null;
  onGo: () => void;
  onTakeOver: () => void;
  onResume: () => void;
  /** Close the outside claude and resume the session here; null when the shell can't release. */
  onMove: (() => void) | null;
}

function LiveSessionCard({ agent: a, now, canFocus, busy, last, onGo, onTakeOver, onResume, onMove }: LiveSessionCardProps) {
  const name = agentName(a);
  const color = heroColor(a.sessionId);
  const epithet = epithetOf(a.sessionId, name, a.isSquire);
  const activity = activityLine(a);
  const running = a.alive && a.pid !== null;
  return (
    <div className="live-card-wrap">
      <div className="live-card">
        <div className="live-card-kicker">{running ? 'Running in another terminal' : 'This session has ended'}</div>
        <div className="live-card-hero">
          <Portrait sessionId={a.sessionId} color={color} scale={2} squire={a.isSquire} />
          <div className="live-card-id">
            <div className="live-card-name" title={epithetTitle(a.sessionId, name, a.isSquire)}>
              {epithet.prefix && <span className="ui-epithet-pre">{epithet.prefix} </span>}
              <span className="live-card-name-main">{name}</span>
              {epithet.suffix && <span className="ui-epithet-suf"> {epithet.suffix}</span>}
            </div>
            <div className="live-card-place">{agentPlaceLabel(a)}</div>
            <div className="live-card-status">
              <StatusPill status={a.status} />
              <span className="live-card-when" title={new Date(a.lastEventAt).toLocaleString()}>
                {relTime(a.lastEventAt, now)}
              </span>
            </div>
          </div>
        </div>
        <div className="live-card-flavor">{flavorLine(a)}</div>
        {activity && <div className="live-card-activity">{activity}</div>}

        {running ? (
          <>
            {onMove && (
              <>
                <button
                  type="button"
                  className="drawer-btn drawer-btn-primary live-card-go"
                  onClick={onMove}
                  title="Close it in the other terminal and resume it in a village tab"
                >
                  ⇲ Move here
                </button>
                <div className="live-card-note">
                  Closes it in the other terminal and resumes it here — one Claude, same history. Mid-turn, it waits
                  for the turn to end.
                </div>
              </>
            )}
            {canFocus && (
              <>
                <button
                  type="button"
                  className={`drawer-btn ${onMove ? 'drawer-btn-ghost' : 'drawer-btn-primary'} live-card-go`}
                  onClick={onGo}
                  disabled={busy}
                  title="Bring that terminal window to the front"
                >
                  {busy ? 'Finding its window…' : '↗ Go to terminal'}
                </button>
                <div className="live-card-note">
                  {last && last.ok
                    ? `Last time: ${last.app ?? 'window'}${last.tab ? ` · tab “${bareTitle(last.tab)}”` : ''}`
                    : 'Switches to the window (and tab) where it already runs — no second Claude.'}
                </div>
              </>
            )}
            <div className="live-card-alt">
              <button type="button" className="drawer-btn drawer-btn-ghost live-card-takeover" onClick={onTakeOver}>
                Take over here
              </button>
              <span className="live-card-warn">
                Starts a second Claude process on this session; MCP and permission prompts may appear.
              </span>
            </div>
          </>
        ) : (
          <button type="button" className="drawer-btn drawer-btn-primary live-card-go" onClick={onResume}>
            ↻ Resume here
          </button>
        )}
      </div>
    </div>
  );
}

// ── Place chooser ────────────────────────────────────────────────────────────

interface PlaceChooserProps {
  chooser: Chooser;
  agents: AgentState[];
  hasTabs: boolean;
  onLaunch: (repo: RepoDef) => void;
  onOpen: (a: AgentState) => void;
  onBack: () => void;
}

function PlaceChooser({ chooser, agents, hasTabs, onLaunch, onOpen, onBack }: PlaceChooserProps) {
  const { place, repoId } = chooser;
  // Create Party lists every place (map order, then the tavern); a building click lists just its own.
  const places = place ? [place] : [...allPlaces(), TAVERN_PLACE];
  const heroesHere = place
    ? agents.filter((a) => {
        const r = resolveAgentPlace(a);
        return r ? r.place.id === place.id : place.id === TAVERN_PLACE.id;
      })
    : [];

  const repoList = (pl: PlaceDef) => (
    <ul className="drawer-chooser-list">
      {launchTargets(pl).map((r) => (
        <li key={r.id} className={`drawer-chooser-item ${r.id === repoId ? 'drawer-chooser-item-hint' : ''}`}>
          <div className="drawer-chooser-repo">
            <span className="drawer-chooser-name">{r.name}</span>
            <span className="drawer-chooser-cwd" title={r.cwd}>
              {r.cwd}
            </span>
          </div>
          <div className="drawer-chooser-btns">
            <button
              type="button"
              className="drawer-btn drawer-btn-primary"
              onClick={() => onLaunch(r)}
              title={`claude --name ${NAMELESS} in ${r.cwd}`}
            >
              ✦ New session
            </button>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="drawer-chooser">
      {place ? (
        <>
          <div className="drawer-chooser-kicker">Start a quest in</div>
          <h2 className="drawer-chooser-title">{place.name}</h2>
          <p className="drawer-chooser-tagline">{place.tagline}</p>
          {repoList(place)}
        </>
      ) : (
        <>
          <div className="drawer-chooser-kicker">Create a party</div>
          <h2 className="drawer-chooser-title">Where does the quest begin?</h2>
          <p className="drawer-chooser-tagline">
            Pick a project — a fresh <code>claude --name {NAMELESS}</code> starts in its folder, right here.
          </p>
          {places.map((pl) => (
            <section key={pl.id} className="drawer-chooser-place">
              <h3 className="drawer-chooser-place-name">
                {pl.name}
                <span className="drawer-chooser-place-tag">{pl.tagline}</span>
              </h3>
              {repoList(pl)}
            </section>
          ))}
        </>
      )}

      {heroesHere.length > 0 && (
        <div className="drawer-chooser-heroes">
          <div className="drawer-chooser-sub">Heroes already here</div>
          <div className="drawer-chooser-chips">
            {heroesHere.map((a) => (
              <button
                key={a.sessionId}
                type="button"
                className="drawer-chip"
                style={{ borderColor: heroColor(a.sessionId) }}
                onClick={() => onOpen(a)}
                title={
                  a.alive && a.pid !== null
                    ? `${agentName(a)} · ${a.shortId} — running in another terminal`
                    : `Resume ${agentName(a)} · ${a.shortId}`
                }
              >
                <span className="drawer-chip-dot" style={{ background: heroColor(a.sessionId) }} />
                {agentName(a)}
              </button>
            ))}
          </div>
        </div>
      )}

      {hasTabs && (
        <button type="button" className="drawer-btn drawer-btn-ghost drawer-chooser-back" onClick={onBack}>
          ← Back to terminals
        </button>
      )}
    </div>
  );
}
