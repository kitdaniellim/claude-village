// Layout shell: TopBar / [PartyBar | Village (+ backpack overlay) | TerminalDrawer]
// / ActivityFeed dock. In terminal Focus mode the drawer fills the main area and
// the village shrinks to a live preview under the party. Owns the UI state and
// wires useAgentSocket data into every panel.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isBool, usePersistentState } from './hooks/usePersistentState';
import { useAgentSocket } from './hooks/useAgentSocket';
import { useSound } from './hooks/useSound';
import { useDesktopSettings } from './hooks/useDesktopSettings';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useDrawerWidth } from './hooks/useDrawerWidth';
import { useFeedDock, useUnreadEvents } from './hooks/useFeedDock';
import { useRally } from './hooks/useRally';
import TopBar from './components/TopBar';
import PartyBar from './components/PartyBar';
import ActivityFeed from './components/ActivityFeed';
import Village from './components/Village';
import type { FocusRequest } from './components/Village';
import TerminalPanel from './components/TerminalPanel';
import PanelBoundary from './components/PanelBoundary';
import type { LeaderState, MoveRequest, MoveStatus, PlaceRequest, RallyRequest } from './components/TerminalPanel';
import type { RallySession } from './types/agent';
import type { BlockedMap, SleepingHero } from './utils/terminalTabs';
import { BLOCKED_MAX, BLOCKED_NOTE_MAX, isBlockedMap } from './utils/terminalTabs';
import { LEADER_NAME, leaderOf } from './utils/agentLabel';
import { useReviews } from './hooks/useReviews';
import RewardsPanel from './components/RewardsPanel';
import AwardToasts from './components/AwardToasts';
import MapEditor, {
  DEFAULT_LAYOUT,
  clearSavedLayout,
  loadLayout,
  saveLayout,
} from './components/MapEditor';
import type { LayoutMap } from './components/MapEditor';

/** A killed session may log one last line; don't let that bring it back. */
const DISMISS_GRACE_MS = 15_000;
const MAX_DISMISSED = 40;

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isDismissedMap(v: unknown): v is Record<string, number> {
  return !!v && typeof v === 'object' && Object.values(v as object).every((n) => typeof n === 'number');
}
import './App.css';

const PARTY_W = 260;

function initialNight(): boolean {
  const h = new Date().getHours();
  return h < 7 || h >= 19;
}

export default function App() {
  const { agents, events, claudeDirs, connection, skewMs, rewards, lastAward, synced } = useAgentSocket();

  // UI preferences persist: the app reopens the way it was left (night, WAR, scale, grid).
  const [night, setNight] = usePersistentState('night', initialNight, isBool);
  const [editor, setEditor] = useState(false);
  // WAR mode: idle villagers spread out to fight the monsters — visual only, never touches a session.
  const [war, setWar] = usePersistentState('war', false, isBool);
  const [scaleMode, setScaleMode] = usePersistentState<'fit' | '2x'>(
    'scale',
    'fit',
    (v): v is 'fit' | '2x' => v === 'fit' || v === '2x'
  );
  const [showGrid, setShowGrid] = usePersistentState('grid', false, isBool);
  const [layout, setLayout] = useState<LayoutMap>(loadLayout);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  /** Same shape as `focus`, but only for user picks: routes the drawer to that hero's terminal. */
  const [terminalRequest, setTerminalRequest] = useState<FocusRequest | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  /** When the user last picked a hero — an adoption never overrides a later pick. */
  const lastPickAt = useRef(0);
  const [sleepers, setSleepers] = useState<SleepingHero[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [placeRequest, setPlaceRequest] = useState<PlaceRequest | null>(null);
  const [rallyRequest, setRallyRequest] = useState<RallyRequest | null>(null);
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null);
  const [moveStatus, setMoveStatus] = useState<MoveStatus | null>(null);
  const [drawerWidth, setDrawerWidth] = useDrawerWidth();
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const rewardsOpenRef = useRef(rewardsOpen);
  rewardsOpenRef.current = rewardsOpen;
  // Terminal Focus mode is remembered; it only applies while the drawer is open.
  const [termFocus, setTermFocus] = usePersistentState('terminal-focus', false, isBool);
  const focusActive = drawerOpen && termFocus;
  const filterRef = useRef<HTMLInputElement | null>(null);

  const feed = useFeedDock();
  const feedUnread = useUnreadEvents(events, feed.mode === 'open');
  const desktop = useDesktopSettings();
  const sound = useSound(agents, events, selectedSessionId);
  const rallyAll = useRally(agents, connection);
  // Dismissed from the party (✕): sessionId → when. Hidden until the session logs something newer.
  const [dismissed, setDismissed] = usePersistentState<Record<string, number>>('party-dismissed', {}, isDismissedMap);
  const [dismissRequest, setDismissRequest] = useState<FocusRequest | null>(null);
  const isDismissed = useCallback(
    (sessionId: string, lastAt: number): boolean => {
      const at = dismissed[sessionId];
      return at !== undefined && lastAt <= at + DISMISS_GRACE_MS;
    },
    [dismissed],
  );
  const partyAgents = useMemo(() => agents.filter((a) => !isDismissed(a.sessionId, a.lastEventAt)), [agents, isDismissed]);
  // A dismissed session isn't "recently closed" either.
  const rally = useMemo(
    () => ({ ...rallyAll, sessions: rallyAll.sessions.filter((s) => !isDismissed(s.sessionId, s.lastAliveAt)) }),
    [rallyAll, isDismissed],
  );
  const handleDismiss = useCallback((sessionId: string) => {
    setDismissed((cur) => {
      const next = { ...cur, [sessionId]: Date.now() };
      // Keep the newest few (prefs values are size-capped).
      const keep = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, MAX_DISMISSED);
      return Object.fromEntries(keep);
    });
    setDismissRequest((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
    setSelectedSessionId((cur) => (cur === sessionId ? null : cur));
  }, [setDismissed]);
  // Blocked labels (UI only): sessionId → optional note. Shown on party cards and the drawer.
  const [blocked, setBlocked] = usePersistentState<BlockedMap>('party-blocked', {}, isBlockedMap);
  const handleSetBlocked = useCallback(
    (sessionId: string, note: string | null) => {
      setBlocked((cur) => {
        const next = { ...cur };
        if (note === null) delete next[sessionId];
        else next[sessionId] = { note: note.trim().slice(0, BLOCKED_NOTE_MAX), at: Date.now() };
        // Keep the newest few (prefs values are size-capped).
        return Object.fromEntries(Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, BLOCKED_MAX));
      });
    },
    [setBlocked],
  );
  // Party Leader: which parties it reviews (saved), its verdicts, the review queue, recruit clicks.
  const [reviewIds, setReviewIds] = usePersistentState<string[]>('party-review', [], isStringList);
  const leaderAlive = !!leaderOf(agents)?.alive;
  const { verdicts, ready: verdictsReady } = useReviews(reviewIds.length > 0 || leaderAlive);
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [leaderState, setLeaderState] = useState<LeaderState>('ok');
  const [reviewNowRequest, setReviewNowRequest] = useState<FocusRequest | null>(null);
  const handleReviewQueue = useCallback((ids: string[], state: LeaderState) => {
    setReviewQueue(ids);
    setLeaderState(state);
  }, []);
  const handleReviewNow = useCallback((sessionId: string) => {
    setReviewNowRequest((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const [leaderRequest, setLeaderRequest] = useState<{ nonce: number } | null>(null);
  const handleToggleReview = useCallback(
    (sessionId: string) =>
      setReviewIds((cur) => (cur.includes(sessionId) ? cur.filter((x) => x !== sessionId) : [...cur, sessionId].slice(-40))),
    [setReviewIds],
  );
  // The drawer switched terminals on its own (Create Party, Rally, Move): highlight that hero.
  const handleActiveChange = useCallback((id: string | null) => {
    if (id) setSelectedSessionId(id);
  }, []);

  // Desktop settings win once on load; afterwards every toggle is mirrored back.
  const adoptedDesktopSound = useRef(false);
  const { settings: desktopSettings, update: updateDesktop } = desktop;
  const { enabled: soundOn, setEnabled: setSoundOn } = sound;
  useEffect(() => {
    if (!desktopSettings) return;
    if (!adoptedDesktopSound.current) {
      adoptedDesktopSound.current = true;
      setSoundOn(desktopSettings.sound);
      return;
    }
    if (desktopSettings.sound !== soundOn) updateDesktop({ sound: soundOn });
  }, [desktopSettings, updateDesktop, soundOn, setSoundOn]);

  const handleLayoutChange = useCallback((next: LayoutMap) => {
    setLayout(next);
    saveLayout(next);
  }, []);

  const handleResetLayout = useCallback(() => {
    clearSavedLayout();
    setLayout({ ...DEFAULT_LAYOUT });
  }, []);

  const closeRewards = useCallback(() => setRewardsOpen(false), []);

  // Hero clicked (party card, village or backpack row): select, pulse, open its terminal.
  const handleSelectAgent = useCallback(
    (sessionId: string) => {
      lastPickAt.current = Date.now();
      setSelectedSessionId(sessionId);
      setFocus((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
      setTerminalRequest((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
      setDrawerOpen(true);
      closeRewards();
    },
    [closeRewards],
  );

  // Only ever one Leader: if one exists (running, ended or asleep in a tab) open it instead.
  const existingLeaderId =
    leaderOf(agents)?.sessionId ?? sleepers.find((s) => s.name.trim().toUpperCase() === LEADER_NAME)?.sessionId ?? null;
  const handleRecruitLeader = useCallback(() => {
    if (existingLeaderId) {
      handleSelectAgent(existingLeaderId);
      return;
    }
    setLeaderRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }));
    setDrawerOpen(true);
  }, [existingLeaderId, handleSelectAgent]);

  // A Create Party / Fetch Squire hero just appeared for its tab: highlight it and pulse the map,
  // unless the user picked someone after launching. Its tab is already open, so no terminal routing.
  const handleHeroAdopted = useCallback((sessionId: string, launchedAt: number) => {
    if (lastPickAt.current > launchedAt) return;
    setSelectedSessionId(sessionId);
    setFocus((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Building / city clicked (village or backpack place): open the quest chooser.
  const handleSelectPlace = useCallback(
    (placeId: string, repoId: string | null) => {
      setPlaceRequest((prev) => ({ placeId, repoId, nonce: (prev?.nonce ?? 0) + 1 }));
      setDrawerOpen(true);
      closeRewards();
    },
    [closeRewards],
  );

  // "Create Party (New Session)": a fresh Nameless terminal in the coding root.
  const handleCreateParty = useCallback(() => {
    setPlaceRequest((prev) => ({ placeId: null, repoId: null, nonce: (prev?.nonce ?? 0) + 1 }));
    setDrawerOpen(true);
    closeRewards();
  }, [closeRewards]);

  // Rally card: reopen the sessions a power cut / restart killed, each in its own drawer tab.
  const handleRally = useCallback(
    (sessions: RallySession[]) => {
      if (sessions.length === 0) return;
      setRallyRequest((prev) => ({ sessions, nonce: (prev?.nonce ?? 0) + 1 }));
      setDrawerOpen(true);
      closeRewards();
    },
    [closeRewards],
  );

  // Move into the village: outside claudes close and resume in drawer tabs (mid-turn ones wait).
  const handleMove = useCallback(() => {
    setMoveRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1 }));
    setDrawerOpen(true);
    closeRewards();
  }, [closeRewards]);
  const handleCancelMove = useCallback(() => {
    setMoveRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, cancel: true }));
  }, []);

  // The backpack lives over the village, so opening it leaves Focus mode.
  const toggleRewards = useCallback(() => {
    const opening = !rewardsOpenRef.current;
    if (opening && drawerOpen) setTermFocus(false);
    setRewardsOpen(opening);
  }, [drawerOpen, setTermFocus]);

  // Ctrl+Shift+F / the drawer's Focus button: opens the drawer when it's shut.
  const toggleTerminalFocus = useCallback(() => {
    if (!drawerOpen) {
      setDrawerOpen(true);
      setTermFocus(true);
    } else {
      setTermFocus((v) => !v);
    }
    closeRewards();
  }, [drawerOpen, setTermFocus, closeRewards]);

  // Esc closes the top-most layer: rewards panel first, then the drawer.
  const closeTopmost = useCallback(() => {
    if (rewardsOpenRef.current) closeRewards();
    else setDrawerOpen(false);
  }, [closeRewards]);

  useKeyboardShortcuts({
    toggleDrawer: () => setDrawerOpen((v) => !v),
    toggleSound: sound.toggle,
    toggleFeed: feed.toggle,
    toggleBackpack: toggleRewards,
    toggleTerminalFocus,
    escape: closeTopmost,
    focusFilter: () => filterRef.current?.focus(),
  });

  const columns = focusActive
    ? `${PARTY_W}px minmax(0, 1fr)`
    : drawerOpen
      ? `${PARTY_W}px minmax(0, 1fr) ${drawerWidth}px`
      : `${PARTY_W}px minmax(0, 1fr)`;
  // Award toast clicked → backpack open on that entry's summary.
  const [rewardsFocus, setRewardsFocus] = useState<{ id: string; nonce: number } | null>(null);
  const openAwardEntry = useCallback((id: string) => {
    setRewardsOpen(true);
    setRewardsFocus((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const toasts = (
    <PanelBoundary name="Award toasts">
      <AwardToasts lastAward={lastAward} rewards={rewards} onOpen={openAwardEntry} />
    </PanelBoundary>
  );

  return (
    <div className="app" data-feed={feed.mode}>
      <PanelBoundary name="Top bar">
        <TopBar
          connection={connection}
          agents={agents}
          night={night}
          onToggleNight={() => setNight((v) => !v)}
          editor={editor}
          onToggleEditor={() => setEditor((v) => !v)}
          scaleMode={scaleMode}
          onScaleMode={setScaleMode}
          showGrid={showGrid}
          onShowGrid={setShowGrid}
          sound={sound.enabled}
          onToggleSound={sound.toggle}
          desktop={desktop}
          feedMode={feed.mode}
          feedUnread={feedUnread}
          onToggleFeed={() => feed.setMode(feed.mode === 'closed' ? 'open' : 'closed')}
          rewardsOpen={rewardsOpen}
          onToggleRewards={toggleRewards}
          itemCount={rewards?.journal.length ?? 0}
          awardNonce={lastAward?.nonce ?? 0}
          war={war}
          onToggleWar={() => setWar((v) => !v)}
        />
      </PanelBoundary>
      <main className={`app-main ${focusActive ? 'app-main-focus' : ''}`} style={{ gridTemplateColumns: columns }}>
        <PanelBoundary name="Party">
          <PartyBar
            agents={partyAgents}
            skewMs={skewMs}
            selectedSessionId={selectedSessionId}
            onSelect={handleSelectAgent}
            filterRef={filterRef}
            onCreateParty={handleCreateParty}
            sleepers={sleepers}
            rally={rally}
            onRally={handleRally}
            moveStatus={moveStatus}
            onMove={handleMove}
            onCancelMove={handleCancelMove}
            onRestartApp={desktop.bridge ? () => desktop.bridge?.restart() : null}
            onDismiss={handleDismiss}
            blocked={blocked}
            reviewIds={reviewIds}
            verdicts={verdicts}
            reviewQueue={reviewQueue}
            leaderState={leaderState}
            onReviewNow={handleReviewNow}
            onRecruitLeader={handleRecruitLeader}
          />
        </PanelBoundary>
        {focusActive && toasts}
        <div className={`app-village ${focusActive ? 'app-village-preview' : ''}`}>
          {!focusActive && toasts}
          <PanelBoundary name="Village map">
            <Village
              agents={agents}
              claudeDirs={claudeDirs}
              connection={connection}
              night={night}
              editor={editor}
              showGrid={showGrid}
              scaleMode={scaleMode}
              layout={layout}
              onLayoutChange={handleLayoutChange}
              focus={focus}
              selectedSessionId={selectedSessionId}
              onSelectAgent={handleSelectAgent}
              onSelectPlace={handleSelectPlace}
              war={war}
            />
          </PanelBoundary>
          <div className="app-vignette" aria-hidden="true" />
          {focusActive && (
            <button
              type="button"
              className="app-preview-exit"
              onClick={() => setTermFocus(false)}
              title="Back to the village (exit focus mode)"
            >
              <span className="app-preview-label">Village · click to exit focus</span>
            </button>
          )}
          {editor && (
            <MapEditor onReset={handleResetLayout} onClose={() => setEditor(false)} />
          )}
          <PanelBoundary name="Backpack">
            <RewardsPanel
              open={rewardsOpen && !focusActive}
              onClose={closeRewards}
              rewards={rewards}
              agents={agents}
              skewMs={skewMs}
              onSelectAgent={handleSelectAgent}
              onSelectPlace={handleSelectPlace}
              awardNonce={lastAward?.nonce ?? 0}
              lastAward={lastAward?.award ?? null}
              focusEntry={rewardsFocus}
            />
          </PanelBoundary>
        </div>
        <TerminalPanel
          open={drawerOpen}
          width={drawerWidth}
          onWidthChange={setDrawerWidth}
          onClose={() => setDrawerOpen(false)}
          bridge={desktop.bridge}
          agents={agents}
          sessionRequest={terminalRequest}
          placeRequest={placeRequest}
          focusMode={focusActive}
          onToggleFocus={toggleTerminalFocus}
          synced={synced}
          onHeroAdopted={handleHeroAdopted}
          onSleepers={setSleepers}
          onRestoreDrawer={setDrawerOpen}
          rallyRequest={rallyRequest}
          moveRequest={moveRequest}
          onMoveStatus={setMoveStatus}
          dismissRequest={dismissRequest}
          blocked={blocked}
          onSetBlocked={handleSetBlocked}
          reviewIds={reviewIds}
          verdicts={verdicts}
          verdictsReady={verdictsReady}
          leaderRequest={leaderRequest}
          onToggleReview={handleToggleReview}
          onReviewQueue={handleReviewQueue}
          reviewNowRequest={reviewNowRequest}
          onReviewNow={handleReviewNow}
          onActiveChange={handleActiveChange}
        />
      </main>
      <PanelBoundary name="Activity feed">
        <ActivityFeed
          events={events}
          mode={feed.mode}
          unread={feedUnread}
          onMode={feed.setMode}
        />
      </PanelBoundary>
    </div>
  );
}
