// Layout shell: TopBar / [PartyBar | Village | TerminalDrawer] / ActivityFeed.
// Owns the UI state (day-night, editor, settings, layout, selection, drawer,
// sound) and wires useAgentSocket data into every panel.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentSocket } from './hooks/useAgentSocket';
import { useSound } from './hooks/useSound';
import { useDesktopSettings } from './hooks/useDesktopSettings';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useDrawerWidth } from './hooks/useDrawerWidth';
import TopBar from './components/TopBar';
import PartyBar from './components/PartyBar';
import ActivityFeed from './components/ActivityFeed';
import Village from './components/Village';
import type { FocusRequest } from './components/Village';
import TerminalPanel from './components/TerminalPanel';
import type { PlaceRequest } from './components/TerminalPanel';
import MapEditor, {
  DEFAULT_LAYOUT,
  clearSavedLayout,
  loadLayout,
  saveLayout,
} from './components/MapEditor';
import type { LayoutMap } from './components/MapEditor';
import './App.css';

const PARTY_W = 260;

function initialNight(): boolean {
  const h = new Date().getHours();
  return h < 7 || h >= 19;
}

export default function App() {
  const { agents, events, claudeDirs, connection, skewMs } = useAgentSocket();

  const [night, setNight] = useState(initialNight);
  const [editor, setEditor] = useState(false);
  const [scaleMode, setScaleMode] = useState<'fit' | '2x'>('fit');
  const [showGrid, setShowGrid] = useState(false);
  const [layout, setLayout] = useState<LayoutMap>(loadLayout);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [placeRequest, setPlaceRequest] = useState<PlaceRequest | null>(null);
  const [drawerWidth, setDrawerWidth] = useDrawerWidth();
  const filterRef = useRef<HTMLInputElement | null>(null);

  const desktop = useDesktopSettings();
  const sound = useSound(agents, events, selectedSessionId);

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

  // Hero clicked (party card or village): select, pulse, open its terminal.
  const handleSelectAgent = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setFocus((prev) => ({ sessionId, nonce: (prev?.nonce ?? 0) + 1 }));
    setDrawerOpen(true);
  }, []);

  // Building / city clicked: open the quest chooser for that place.
  const handleSelectPlace = useCallback((placeId: string, repoId: string | null) => {
    setPlaceRequest((prev) => ({ placeId, repoId, nonce: (prev?.nonce ?? 0) + 1 }));
    setDrawerOpen(true);
  }, []);

  useKeyboardShortcuts({
    toggleDrawer: () => setDrawerOpen((v) => !v),
    toggleSound: sound.toggle,
    closeDrawer: () => setDrawerOpen(false),
    focusFilter: () => filterRef.current?.focus(),
  });

  const columns = drawerOpen
    ? `${PARTY_W}px minmax(0, 1fr) ${drawerWidth}px`
    : `${PARTY_W}px minmax(0, 1fr)`;

  return (
    <div className="app">
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
      />
      <main className="app-main" style={{ gridTemplateColumns: columns }}>
        <PartyBar
          agents={agents}
          skewMs={skewMs}
          selectedSessionId={selectedSessionId}
          onSelect={handleSelectAgent}
          filterRef={filterRef}
        />
        <div className="app-village">
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
          />
          {editor && (
            <MapEditor onReset={handleResetLayout} onClose={() => setEditor(false)} />
          )}
        </div>
        <TerminalPanel
          open={drawerOpen}
          width={drawerWidth}
          onWidthChange={setDrawerWidth}
          onClose={() => setDrawerOpen(false)}
          bridge={desktop.bridge}
          agents={agents}
          sessionRequest={focus}
          placeRequest={placeRequest}
        />
      </main>
      <ActivityFeed events={events} />
    </div>
  );
}
