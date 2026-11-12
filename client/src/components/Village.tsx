// The world canvas: a 96x60-tile map with the tavern plaza in the centre and
// the user's projects around it (cities, dungeon, dragon lair, wild spots).
// Heroes walk the roads from the tavern to their repo and act out their tool.
// Static art is pre-rendered once per layout (world/terrain.ts); each frame
// only draws sprites, particles and labels. Camera: wheel zoom + drag pan.
// Resting heroes sit on the plaza rest grid (world/plaza.ts) and can be dragged
// to a spot of their own (world/heroSpots.ts); squires shadow their knight.
// A tool error puts a monster beside its hero (world/monsters.ts); WAR mode
// spawns practice monsters and sends every idle villager out to fight them.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { AgentState, AgentStatus, ConnectionStatus } from '../types/agent';
import { hashString, heroColorIndex, toolToBuilding } from '../utils/spriteMapper';
import { errorLine, flavorLine, warLine, wrapText } from '../utils/flavor';
import { allPlaces, isRootCwd, loadWildPlaces, rememberWildPlace, resolveAgentPlace, resolvePlace } from '../world/registry';
import type { ResolvedPlace, WildPlace } from '../world/registry';
import { HERO_SPEED, TILE, TILES_X, TILES_Y, WORLD_H, WORLD_W, footprintFor } from '../world/constants';
import { SQUIRE_LOOK, SQUIRE_SCALE, lookFor } from '../world/lpcHero';
import { REST_MIN_GAP, clampToPlaza, plazaRestSlots } from '../world/plaza';
import { clearHeroSpot, loadHeroSpot, saveHeroSpot } from '../world/heroSpots';
import { MAX_ZOOM, centerOn, clampView, fitView, toScreen, toWorld, zoomAt } from '../world/camera';
import type { View } from '../world/camera';
import { bodyClear, buildWorld, isWalkable, nearestWalkable } from '../world/terrain';
import type { World } from '../world/terrain';
import { createAmbient, drawAmbientBack, drawAmbientFront, emitSparkBurst, updateAmbient } from '../world/ambient';
import type { AmbientState } from '../world/ambient';
import { summarizeHeroes } from '../world/ambientLife';
import { drawDragon, drawHero, drawTypingBubble, startDodge, syncHeroStatus } from '../world/actors';
import { createDragonPlay, dragonFootprint, dragonPlayActive, dragonPlaySortY, drawDragonFx, drawDragonPlay, petFacing, preloadDragonPlay, updateDragonPlay } from '../world/dragonPlay';
import { TYPING_EVENT } from '../utils/typing';
import type { TypingDetail } from '../utils/typing';
import { spinnerVerb } from '../utils/spinnerVerbs';
import type { DragonState, FidgetKind, Foe, Hero } from '../world/actors';
import { MONSTER_IMPACT, attackClearance, createPractice, drawMonster, monsterAlive, monsterCentre, monsterGap, monsterHit, strikeMonster, updateMonsters, updatePractice } from '../world/monsters';
import type { Monster, Practice } from '../world/monsters';
import type { BuildingGeom, PlaceGeom } from '../world/places';
import { nearestIndex, inRect, rectsOverlap } from '../world/geometry';
import { nearRoad } from '../world/roads';
import { PLATE_H, drawBanner, drawParchment, drawPlate, drawRectOutline, drawSpeechBubble, drawTextOutlined, hash32, mulberry32, plateWidth } from '../world/pixel';
import type { Pt } from '../world/pixel';
import type { LayoutMap } from './MapEditor';
import './Village.css';

export interface FocusRequest {
  sessionId: string;
  nonce: number;
}

export interface VillageProps {
  agents: AgentState[];
  claudeDirs: string[];
  connection: ConnectionStatus;
  night: boolean;
  editor: boolean;
  showGrid: boolean;
  scaleMode: 'fit' | '2x';
  layout: LayoutMap;
  onLayoutChange: (next: LayoutMap) => void;
  focus: FocusRequest | null;
  selectedSessionId: string | null;
  onSelectAgent: (sessionId: string) => void;
  onSelectPlace: (placeId: string, repoId: string | null) => void;
  /** WAR mode: idle villagers spread out to fight the monsters / drill in formation. */
  war: boolean;
}

const CAM_EASE_MS = 300;
const FIDGETS: FidgetKind[] = ['look', 'stretch', 'sip', 'hop', 'look'];
const FIDGET_DUR: Record<FidgetKind, number> = { look: 0.7, stretch: 0.9, sip: 1.2, hop: 0.35 };

interface Tooltip {
  key: string;
  title: string;
  sub: string;
}

/** Editor: a place footprint follows the pointer. Map: an idle hero is carried around the plaza. */
type Drag = { kind: 'place'; placeId: string; offX: number; offY: number } | { kind: 'hero'; sessionId: string; offX: number; offY: number };

interface PointerState {
  pointerId: number;
  sx: number;
  sy: number;
  moved: boolean;
  startView: View;
  drag: Drag | null;
}

interface DiscoverFx {
  placeId: string;
  t0: number;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A villager's WAR post: a monster to surround (`foe` = its id, `slot` = place in the ring) or a formation point. */
interface WarPost {
  x: number;
  y: number;
  foe: string | null;
  slot: number;
}

type Hit =
  | { kind: 'hero'; hero: Hero }
  | { kind: 'monster'; monster: Monster }
  | { kind: 'building'; place: PlaceGeom; building: BuildingGeom }
  | { kind: 'place'; place: PlaceGeom }
  | null;

const LABEL_MAX = 18;
/** Squires stand a step beside their knight. */
const SQUIRE_SIDE = 22;
/** WAR: how many villagers may surround one monster; their distance from it. */
const WAR_PER_MONSTER = 3;
/** Ring radius beyond the monster's sword-reach gap. */
const WAR_RING_PAD = 2;
const WAR_GRID = 96;
/** Ring angles around a real monster (relative to the side away from its hero) and around a practice one (left, right, front-left). */
const RING_REAL = [0, 0.95, -0.95];
const RING_SIM = [Math.PI, 0, Math.PI * 0.62];
/** The hero leaves this long before the blow lands, so it is ~2/3 of the way out (clear of the reach) on the impact frame. */
const DODGE_LEAD = 0.22;
/** Shortest real dodge (px): even a small monster gets a readable hop. */
const MIN_DODGE = 18;
/** Typing dots show while the last keystroke (not Enter) is this recent. */
const TYPING_HOLD = 1.6;
/** Spinner verbs rotate every 8 s (utils/spinnerVerbs); the caption cross-fades at the edges. */
const VERB_PERIOD_MS = 8000;
/** Practice monsters stand this far from any place so their ring of heroes stays on open ground. */
const PRACTICE_MARGIN = 44;

/** Practice monsters for n drafted villagers: about one per 1.5 heroes, 2–8. */
function practiceWant(n: number): number {
  return Math.min(8, Math.max(2, Math.ceil(n / 1.5)));
}

/** Map name: the user's /rename title or "Nameless" (auto titles are not shown); squires get a ⚔ mark. */
function heroLabel(a: AgentState): string {
  const name = a.customTitle?.trim() || 'Nameless';
  const short = name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
  return a.isSquire ? `⚔ ${short}` : short;
}

/** Statuses that make a hero a villager (free to be drafted in WAR mode). */
function isVillager(status: AgentStatus): boolean {
  return status === 'done' || status === 'idle' || status === 'delegating';
}

/** What the hero is doing, shown in the speech bubble on hover / selection: the unresolved error wins, then the war cry, then flavour. */
function bubbleLine(a: AgentState, atWar: boolean): string {
  if (a.lastError) return wrapText(errorLine(a.lastError), 46, 2);
  if (atWar) return warLine(a);
  return a.status === 'delegating' ? 'Awaiting squire…' : flavorLine(a);
}

/** Plate text under a monster: the failing tool (MCP tools keep their last segment). */
function monsterPlateText(m: Monster): string {
  if (m.simulated) return '👾 mock bug';
  let tool = m.tool?.trim() || 'bug';
  if (tool.startsWith('mcp__')) tool = tool.split('__').pop() || tool;
  if (tool.length > 14) tool = `${tool.slice(0, 13)}…`;
  return `👾 ${tool}`;
}

/** Idle heroes resting on the plaza can be carried to a new spot (squires follow their knight instead). */
function canDragHero(h: Hero, hasParent: boolean): boolean {
  return !h.removing && !hasParent && h.placeId === 'tavern' && h.arrived && !h.moving && (h.status === 'done' || h.status === 'idle');
}

function easeOutCubic(k: number): number {
  return 1 - (1 - k) ** 3;
}

export default function Village(props: VillageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef<VillageProps>(props);
  useLayoutEffect(() => {
    propsRef.current = props;
  });

  const heroesRef = useRef<Map<string, Hero>>(new Map());
  const monstersRef = useRef<Map<string, Monster>>(new Map());
  const warPostsRef = useRef<Map<string, WarPost>>(new Map());
  const formationRef = useRef<{ key: string; pts: Pt[] } | null>(null);
  const groundRef = useRef<{ key: string; pts: Pt[] } | null>(null);
  const practiceRef = useRef<Practice>(createPractice());
  const worldRef = useRef<{ key: string; world: World } | null>(null);
  // Lazily initialised once (plain useRef(init()) would re-run init on every render).
  const wildRef = useRef<WildPlace[] | null>(null);
  /** lastError.path -> resolved place (null = unknown path), so the per-frame lookup stays cheap. */
  const errorPlaceRef = useRef<Map<string, ResolvedPlace | null>>(new Map());
  /** Embedded-terminal keystrokes per session (utils/typing): time of the last one and whether it sent the prompt. */
  const typingRef = useRef<Map<string, { at: number; sent: boolean }>>(new Map());
  if (wildRef.current === null) wildRef.current = loadWildPlaces();
  const wildVersionRef = useRef(0);
  const ambientRef = useRef<AmbientState | null>(null);
  if (ambientRef.current === null) {
    ambientRef.current = createAmbient(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  const dragonRef = useRef<DragonState>({ flapT: 0, lastFrame: -1 });
  /** Simone dragon at play: flies loops, gets chased, lies down to be petted (world/dragonPlay.ts). */
  const dragonPlayRef = useRef(createDragonPlay());
  const nightAmtRef = useRef(props.night ? 1 : 0);
  const fxRef = useRef<DiscoverFx[]>([]);
  const sizeRef = useRef({ cw: 1, ch: 1, dpr: 1 });
  const viewRef = useRef<View>({ z: 1, ox: 0, oy: 0 });
  /** True while the camera sits at the fit view; a resize then refits instead of preserving zoom. */
  const fitLockRef = useRef(true);
  const camAnimRef = useRef<{ from: View; to: View; t0: number } | null>(null);
  const pointerRef = useRef<PointerState | null>(null);
  const hoverRef = useRef<{ key: string; sx: number; sy: number } | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const getWild = (): WildPlace[] => wildRef.current ?? [];
  const getAmbient = (): AmbientState => ambientRef.current ?? (ambientRef.current = createAmbient(false));

  const getWorld = (): World => {
    const p = propsRef.current;
    const key = `${JSON.stringify(p.layout)}|${wildVersionRef.current}`;
    if (!worldRef.current || worldRef.current.key !== key) {
      worldRef.current = { key, world: buildWorld(allPlaces(getWild()), p.layout) };
    }
    return worldRef.current.world;
  };

  const animateTo = (to: View): void => {
    camAnimRef.current = { from: { ...viewRef.current }, to, t0: performance.now() };
  };

  // ── agents → heroes ──
  useEffect(() => {
    const heroes = heroesRef.current;
    const seen = new Set<string>();
    const world = getWorld();
    for (const a of props.agents) {
      seen.add(a.sessionId);
      let h = heroes.get(a.sessionId);
      if (!h) {
        const seed = hashString(a.sessionId);
        const door = world.tavern.gate;
        const x = door.x + ((seed % 9) - 4);
        const y = door.y + 2;
        h = {
          sessionId: a.sessionId,
          shortId: a.shortId,
          label: heroLabel(a),
          agent: a,
          status: a.status,
          category: toolToBuilding(a.tool, a.status),
          placeId: 'tavern',
          repoId: null,
          placeKind: 'tavern',
          targetKey: '',
          worldKey: '',
          x,
          y,
          colorIdx: heroColorIndex(a.sessionId),
          seed,
          look: a.isSquire ? SQUIRE_LOOK : lookFor(seed),
          scale: a.isSquire ? SQUIRE_SCALE : 1,
          isSquire: a.isSquire,
          spot: { x, y },
          restOffset: loadHeroSpot(a.sessionId),
          dragging: false,
          route: [],
          routeI: 0,
          roadId: null,
          arrived: false,
          walk: 0,
          moving: false,
          facing: 1,
          alpha: 0,
          removing: false,
          pulseUntil: 0,
          fidget: null,
          fidgetUntil: 0,
          fidgetDur: 1,
          nextFidgetAt: performance.now() / 1000 + 2,
          actionT: 0,
          pendingBurst: false,
        };
        heroes.set(a.sessionId, h);
      }
      h.shortId = a.shortId;
      h.label = heroLabel(a);
      h.agent = a;
      // status / category follow the agent with hysteresis in the render loop (syncHeroStatus)
      h.isSquire = a.isSquire;
      h.scale = a.isSquire ? SQUIRE_SCALE : 1;
      h.look = a.isSquire ? SQUIRE_LOOK : lookFor(h.seed);
      h.removing = false;
    }
    for (const h of heroes.values()) {
      if (!seen.has(h.sessionId)) h.removing = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.agents]);

  // "You're typing" from the embedded terminals: dots while typing, a perk-up hop on Enter.
  useEffect(() => {
    const onTyping = (e: Event): void => {
      const d = (e as CustomEvent<TypingDetail>).detail;
      if (!d?.sessionId) return;
      const now = performance.now() / 1000;
      typingRef.current.set(d.sessionId, { at: now, sent: d.sent });
      if (d.sent) {
        const h = heroesRef.current.get(d.sessionId);
        if (h) h.perkAt = now;
      }
    };
    window.addEventListener(TYPING_EVENT, onTyping);
    return () => window.removeEventListener(TYPING_EVENT, onTyping);
  }, []);

  // Focus pulse from the PartyBar.
  useEffect(() => {
    if (!props.focus) return;
    const h = heroesRef.current.get(props.focus.sessionId);
    if (h) h.pulseUntil = performance.now() / 1000 + 2.2;
  }, [props.focus]);

  // Canvas sizing + fit camera.
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const apply = (): void => {
      const prev = sizeRef.current;
      const cw = Math.max(1, wrap.clientWidth);
      const ch = Math.max(1, wrap.clientHeight);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { cw, ch, dpr };
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
      cv.style.width = `${cw}px`;
      cv.style.height = `${ch}px`;
      camAnimRef.current = null;
      if (fitLockRef.current) {
        viewRef.current = fitView(cw, ch);
      } else {
        // keep the same world point under the viewport centre
        const v = viewRef.current;
        const c = toWorld(v, prev.cw / 2, prev.ch / 2);
        viewRef.current = centerOn(c.x, c.y, v.z, cw, ch);
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Scale-mode presets: fit resets the camera, 2x zooms onto the tavern.
  useEffect(() => {
    const { cw, ch } = sizeRef.current;
    if (props.scaleMode === 'fit') {
      fitLockRef.current = true;
      animateTo(fitView(cw, ch));
    } else {
      fitLockRef.current = false;
      const world = getWorld();
      const c = world.tavern.plaza?.c ?? { x: WORLD_W / 2, y: WORLD_H / 2 };
      animateTo(centerOn(c.x, c.y + 20, 2, cw, ch));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scaleMode]);

  // Wheel zoom around the cursor (native listener so we can preventDefault).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const { cw, ch } = sizeRef.current;
      const factor = Math.exp(-e.deltaY * 0.0014);
      camAnimRef.current = null;
      fitLockRef.current = false;
      viewRef.current = zoomAt(viewRef.current, e.clientX - rect.left, e.clientY - rect.top, factor, cw, ch);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, []);

  // ── hero targeting / routing ──
  /** The knight a squire follows, if it is on the map. */
  const parentOf = (h: Hero): Hero | null => {
    if (!h.isSquire || !h.agent.squireOf) return null;
    const p = heroesRef.current.get(h.agent.squireOf);
    return p && !p.removing && p !== h ? p : null;
  };

  /** Rest spots other tavern-bound heroes hold (routed at least once; a knight's own squires don't count). */
  const takenRestSpots = (except: Hero): Pt[] => {
    const out: Pt[] = [];
    for (const o of heroesRef.current.values()) {
      if (o === except || o.removing || o.placeId !== 'tavern' || o.targetKey === '') continue;
      if (o.isSquire && o.agent.squireOf === except.sessionId) continue;
      out.push(o.spot);
    }
    return out;
  };

  const minGap = (p: Pt, others: Pt[]): number => others.reduce((m, q) => Math.min(m, Math.hypot(q.x - p.x, q.y - p.y)), Infinity);

  /** Where a squire may stand around a knight at `spot`: either side first, then in front / behind. */
  const squireSpots = (spot: Pt): Pt[] => [
    { x: spot.x + SQUIRE_SIDE, y: spot.y + 2 },
    { x: spot.x - SQUIRE_SIDE, y: spot.y + 2 },
    { x: spot.x, y: spot.y + SQUIRE_SIDE + 2 },
    { x: spot.x, y: spot.y - SQUIRE_SIDE },
  ];

  const hasSquires = (h: Hero): boolean => [...heroesRef.current.values()].some((o) => o.isSquire && !o.removing && o.agent.squireOf === h.sessionId);

  /** Deterministic rest slot: start at the seed's slot, walk to the first one nobody is within REST_MIN_GAP of (knights also need room for a squire). */
  const pickRestSlot = (h: Hero, g: PlaceGeom): Pt => {
    const slots = plazaRestSlots(g);
    const taken = takenRestSpots(h);
    const needSide = hasSquires(h);
    const jitter = ((h.seed >>> 10) % 7) - 3;
    const start = (h.seed >>> 6) % slots.length;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[(start + i) % slots.length] as Pt;
      if (minGap(s, taken) < REST_MIN_GAP) continue;
      if (needSide && !squireSpots(s).some((c) => minGap(c, taken) >= REST_MIN_GAP)) continue;
      return { x: s.x + jitter, y: s.y };
    }
    // every slot busy: share the preferred one, nudged
    const s = slots[start] as Pt;
    return { x: s.x + jitter * 3, y: s.y + ((h.seed >>> 12) % 9) - 4 };
  };

  /** The failing file's building door: its monster waits there and the hero goes to fight it. Null = beside the hero. */
  const errorSite = (h: Hero, world: World): { placeId: string; repoId: string | null; at: Pt } | null => {
    const path = h.removing ? null : (h.agent.lastError?.path ?? null);
    if (!path) return null;
    const cache = errorPlaceRef.current;
    let res = cache.get(path);
    if (res === undefined) {
      res = resolvePlace(path, getWild());
      if (cache.size > 200) cache.clear();
      cache.set(path, res);
    }
    const g = res ? world.byId.get(res.place.id) : undefined;
    if (!res || !g || g.kind === 'tavern') return null;
    const repoId = res.repo?.id ?? null;
    const b = repoId ? g.buildings.find((bb) => bb.repoId === repoId) : undefined;
    const at = b ? { x: b.door.x, y: b.door.y + 4 } : { x: g.square.x, y: g.square.y };
    return { placeId: g.id, repoId, at };
  };

  const spotFor = (h: Hero, world: World, parent: Hero | null): Pt => {
    const g = world.byId.get(h.placeId) ?? null;
    if (parent) {
      // next to the knight, on whichever side has the most room
      const others = takenRestSpots(h).filter((p) => p !== parent.spot);
      const cands = squireSpots(parent.spot).map((p) => (g?.kind === 'tavern' ? clampToPlaza(g, p) : p));
      let best = cands[0] as Pt;
      let bestGap = -1;
      for (const c of cands) {
        const gap = Math.min(minGap(c, others), REST_MIN_GAP); // "enough room" ties keep the earlier (side) candidate
        if (gap > bestGap) {
          best = c;
          bestGap = gap;
        }
      }
      return best;
    }
    const place = g ?? world.tavern;
    const spreadX = ((h.seed % 7) - 3) * 5;
    const spreadY = ((h.seed >>> 4) % 2) * 4;
    if (place.kind === 'tavern' && place.plaza) {
      if (h.restOffset) return clampToPlaza(place, { x: place.plaza.c.x + h.restOffset.x, y: place.plaza.c.y + h.restOffset.y });
      return pickRestSlot(h, place);
    }
    const b = h.repoId ? place.buildings.find((bb) => bb.repoId === h.repoId) : null;
    if (b) return { x: b.door.x + spreadX, y: b.door.y + spreadY };
    return { x: place.square.x + spreadX, y: place.square.y + spreadY };
  };

  // ── WAR mode posts ──
  /** Jittered grid of open ground: `margin` px clear of places (incl. the plaza), off roads. Cached per layout. */
  const openGround = (world: World, margin = 14): Pt[] => {
    const key = `${worldRef.current?.key ?? ''}|${margin}`;
    if (groundRef.current?.key === key) return groundRef.current.pts;
    const cands: Pt[] = [];
    for (let gy = WAR_GRID / 2; gy < WORLD_H; gy += WAR_GRID) {
      for (let gx = WAR_GRID / 2; gx < WORLD_W; gx += WAR_GRID) {
        const j = hash32(`${gx},${gy}`);
        const x = gx + ((j % 41) - 20);
        const y = gy + (((j >>> 8) % 41) - 20);
        if (x < 64 || y < 64 || x > WORLD_W - 64 || y > WORLD_H - 56) continue;
        if (world.places.some((g) => x > g.rect.x - margin && x < g.rect.x + g.rect.w + margin && y > g.rect.y - margin && y < g.rect.y + g.rect.h + margin)) continue;
        if (nearRoad(world.roads, x, y, 12)) continue;
        // never by the pond / on trunks: a fight ring of ~24 px must fit on open ground
        if (!isWalkable(world, x, y, 26)) continue;
        cands.push({ x, y });
      }
    }
    groundRef.current = { key, pts: cands };
    return cands;
  };

  /** Open ground spread by farthest-point picking so n heroes cover the map evenly. */
  const formationPoints = (world: World, n: number): Pt[] => {
    const key = `${worldRef.current?.key ?? ''}|${n}`;
    if (formationRef.current?.key === key) return formationRef.current.pts;
    const cands = openGround(world);
    const pts: Pt[] = [];
    const dist = new Map<Pt, number>(cands.map((c) => [c, Infinity]));
    let next = cands.reduce<Pt | null>((best, c) => (!best || Math.hypot(c.x - WORLD_W / 2, c.y - WORLD_H / 2) < Math.hypot(best.x - WORLD_W / 2, best.y - WORLD_H / 2) ? c : best), null);
    while (next && pts.length < n) {
      pts.push(next);
      let far: Pt | null = null;
      let farD = -1;
      for (const c of cands) {
        if (pts.includes(c)) continue;
        const d = Math.min(dist.get(c) ?? Infinity, Math.hypot(c.x - next.x, c.y - next.y));
        dist.set(c, d);
        if (d > farD) {
          far = c;
          farD = d;
        }
      }
      next = far;
    }
    formationRef.current = { key, pts };
    return pts;
  };

  /** Heroes free to be drafted: villagers that aren't shadowing a knight, in a stable order. */
  const draftees = (): Hero[] =>
    [...heroesRef.current.values()].filter((h) => !h.removing && isVillager(h.status) && parentOf(h) === null).sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));

  /**
   * Villagers surround live monsters (≤ WAR_PER_MONSTER each): real error monsters first, then practice ones
   * (fewest attackers, then nearest). Heroes keep last frame's foe + slot while it lives, so kills don't reshuffle
   * everyone. Only heroes left over once every ring is full drill on the formation grid.
   */
  const computeWarPosts = (world: World, prev: Map<string, WarPost>): Map<string, WarPost> => {
    const posts = new Map<string, WarPost>();
    const villagers = draftees();
    const live = [...monstersRef.current.values()].filter(monsterAlive).sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
    const real = live.filter((m) => !m.simulated);
    const sims = live.filter((m) => m.simulated);
    const byId = new Map(live.map((m) => [m.sessionId, m]));
    const taken = new Map<string, Set<number>>(live.map((m) => [m.sessionId, new Set<number>()]));
    const free = new Set(villagers);
    const assign = (h: Hero, m: Monster, slot: number): void => {
      taken.get(m.sessionId)?.add(slot);
      free.delete(h);
      const ang = m.simulated ? (RING_SIM[slot] ?? 0) : (m.side === 1 ? 0 : Math.PI) + (RING_REAL[slot] ?? 0);
      const ring = monsterGap(m.kind) + WAR_RING_PAD;
      // laid round the monster's prowl centre (stable while it paces) and kept on open ground
      const spot = nearestWalkable(world, {
        x: Math.max(16, Math.min(WORLD_W - 16, m.base.x + Math.cos(ang) * ring)),
        y: Math.max(16, Math.min(WORLD_H - 16, m.base.y + Math.sin(ang) * ring * 0.7)),
      });
      posts.set(h.sessionId, { x: Math.round(spot.x), y: Math.round(spot.y), foe: m.sessionId, slot });
    };
    const freeSlot = (m: Monster): number | null => {
      const used = taken.get(m.sessionId);
      for (let i = 0; i < WAR_PER_MONSTER; i++) if (!used?.has(i)) return i;
      return null;
    };
    let simCap = WAR_PER_MONSTER;
    const full = (m: Monster): boolean => (taken.get(m.sessionId)?.size ?? 0) >= (m.simulated ? simCap : WAR_PER_MONSTER);
    const keepSticky = (simulated: boolean): void => {
      for (const h of villagers) {
        const old = prev.get(h.sessionId);
        const m = old?.foe ? byId.get(old.foe) : undefined;
        if (!old || !m || m.simulated !== simulated || !free.has(h) || taken.get(m.sessionId)?.has(old.slot) || full(m)) continue;
        assign(h, m, old.slot);
      }
    };
    const nearestFree = (m: Monster): Hero | null => {
      let best: Hero | null = null;
      for (const h of free) if (!best || Math.hypot(h.x - m.x, h.y - m.y) < Math.hypot(best.x - m.x, best.y - m.y)) best = h;
      return best;
    };
    // real errors: keep, then pull the nearest free villagers in
    keepSticky(false);
    for (const m of real) {
      for (let slot = freeSlot(m); slot !== null && free.size > 0; slot = freeSlot(m)) assign(nearestFree(m) as Hero, m, slot);
    }
    // practice monsters share the free heroes evenly (cap per monster); keep; whoever just made a kill holds the spot until the replacement appears; spread the rest evenly
    simCap = Math.min(WAR_PER_MONSTER, Math.max(1, Math.ceil(free.size / Math.max(1, sims.length))));
    keepSticky(true);
    const respawning = practiceRef.current.respawnAt.length > 0;
    for (const h of [...free]) {
      const old = prev.get(h.sessionId);
      if (respawning && old?.foe?.startsWith('sim:') && !byId.has(old.foe)) {
        posts.set(h.sessionId, old);
        free.delete(h);
        continue;
      }
      let best: Monster | null = null;
      let bestScore = Infinity;
      for (const m of sims) {
        if (freeSlot(m) === null || full(m)) continue;
        const score = (taken.get(m.sessionId)?.size ?? 0) * 10000 + Math.hypot(h.x - m.x, h.y - m.y);
        if (score < bestScore) {
          best = m;
          bestScore = score;
        }
      }
      if (best) assign(h, best, freeSlot(best) as number);
    }
    // last resort: more heroes than rings — drill in formation
    const rest = villagers.filter((h) => free.has(h));
    const pts = formationPoints(world, rest.length);
    rest.forEach((h, i) => {
      const p = pts[i];
      if (p) posts.set(h.sessionId, { x: p.x, y: p.y, foe: null, slot: 0 });
    });
    return posts;
  };

  const retarget = (h: Hero, world: World, t: number): void => {
    const a = h.agent;
    let placeId = 'tavern';
    let repoId: string | null = null;
    const parent = parentOf(h);
    const site = parent ? null : errorSite(h, world);
    // its own monster set a meeting spot (both walk there and fight at sword's reach)
    const fm = parent ? undefined : monstersRef.current.get(h.sessionId);
    const meetAt = fm && monsterAlive(fm) && fm.heroAt ? fm : null;
    const post = propsRef.current.war && !parent && !site && !meetAt ? (warPostsRef.current.get(h.sessionId) ?? null) : null;
    if (parent) {
      // squires go where their knight goes
      placeId = parent.placeId;
      repoId = parent.repoId;
    } else if (site) {
      placeId = site.placeId;
      repoId = site.repoId;
    } else if (post) {
      placeId = 'war';
    } else if (h.status !== 'idle' && h.status !== 'done') {
      let res = resolveAgentPlace(a, getWild());
      if (!res) {
        const cwd = a.cwd ?? a.rootCwd;
        if (cwd && !isRootCwd(cwd)) {
          const next = rememberWildPlace(cwd, getWild());
          if (next.length !== getWild().length) {
            wildRef.current = next;
            wildVersionRef.current++;
            const added = next[next.length - 1];
            if (added) fxRef.current.push({ placeId: added.id, t0: t });
            res = resolveAgentPlace(a, next);
          }
        }
      }
      if (res) {
        placeId = res.place.id;
        repoId = res.repo?.id ?? null;
      } else if ((h.status === 'running' || h.status === 'thinking') && h.placeId !== 'tavern' && h.placeId !== 'war') {
        // still working but the place is unknown this beat: stay put rather than drift to the square
        placeId = h.placeId;
        repoId = h.repoId;
      }
    }
    // an error at a known building, or a monster walking up to the hero: meet it there (until it is slain)
    let errSpot: Pt | null = null;
    if (meetAt?.heroAt && (site || meetAt.homeKey === `${placeId}/${repoId ?? ''}`)) errSpot = meetAt.heroAt;
    else if (site) errSpot = { x: site.at.x - monsterGap('goblin') - 24, y: site.at.y };
    // a squire's key carries the knight's spot so it re-routes when the knight is dragged; a war post its position
    const key = parent
      ? `${placeId}/${repoId ?? ''}|${Math.round(parent.spot.x)},${Math.round(parent.spot.y)}`
      : errSpot
        ? `err|${placeId}/${repoId ?? ''}|${Math.round(errSpot.x)},${Math.round(errSpot.y)}`
        : post
        ? `war|${Math.round(post.x)},${Math.round(post.y)}|${post.foe ?? ''}`
        : `${placeId}/${repoId ?? ''}`;
    if (key === h.targetKey && h.worldKey === worldRef.current?.key) return;
    const w = worldRef.current?.key !== h.worldKey ? getWorld() : world;
    const offRoad = placeId === 'war';
    const wasErr = h.targetKey.startsWith('err|');
    const samePlace = h.placeId === placeId;
    h.targetKey = key;
    h.worldKey = worldRef.current?.key ?? '';
    h.placeId = placeId;
    h.repoId = repoId;
    h.placeKind = w.byId.get(placeId)?.kind ?? (offRoad ? 'wild' : 'tavern');
    h.arrived = false;
    // stepping up to meet a monster (or back after it falls) inside the same place: walk straight there, not round the road
    const target = errSpot ?? (post ? { x: post.x, y: post.y } : spotFor(h, w, parent));
    const direct = (errSpot !== null || wasErr) && samePlace && Math.hypot(h.x - target.x, h.y - target.y) < 90;
    // Route: back down the current road to the plaza, then up the target's road, then to the spot.
    // War posts are off-road: leave a place by its gate, then march straight there.
    const pts: Pt[] = [];
    if (direct) {
      // no road legs
    } else if (h.roadId && h.roadId !== placeId) {
      const road = w.roads.main.get(h.roadId);
      if (road) {
        const i = nearestIndex(road.pts, h.x, h.y);
        const g = w.byId.get(h.roadId);
        const from = offRoad && g ? Math.min(i, nearestIndex(road.pts, g.approach.x, g.approach.y)) : 0;
        pts.push(...road.pts.slice(from, i + 1).reverse());
      }
      h.roadId = null;
    }
    if (placeId !== 'tavern' && !offRoad && !direct) {
      const road = w.roads.main.get(placeId);
      if (road) {
        const i = h.roadId === placeId ? nearestIndex(road.pts, h.x, h.y) : 0;
        pts.push(...road.pts.slice(i));
      }
      h.roadId = placeId;
    }
    const spot = target;
    pts.push(spot);
    h.spot = spot;
    h.route = pts;
    h.routeI = 0;
  };

  // ── render loop ──
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    const stars = (() => {
      const rng = mulberry32(0x57a125);
      return Array.from({ length: 90 }, () => ({ fx: rng(), fy: rng(), phase: rng() * Math.PI * 2, size: rng() < 0.8 ? 1 : 2 }));
    })();

    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const p = propsRef.current;
      const world = getWorld();
      const { cw, ch, dpr } = sizeRef.current;
      const st = getAmbient();

      // camera easing (retargets from the current view when a new target arrives)
      const anim = camAnimRef.current;
      if (anim) {
        const k = Math.min(1, (now - anim.t0) / CAM_EASE_MS);
        const e = easeOutCubic(k);
        viewRef.current = clampView(
          { z: anim.from.z + (anim.to.z - anim.from.z) * e, ox: anim.from.ox + (anim.to.ox - anim.from.ox) * e, oy: anim.from.oy + (anim.to.oy - anim.from.oy) * e },
          cw,
          ch,
        );
        if (k >= 1) camAnimRef.current = null;
      }
      const view = viewRef.current;

      // day/night easing
      const targetNight = p.night ? 1 : 0;
      const amt = nightAmtRef.current;
      nightAmtRef.current = Math.max(0, Math.min(1, amt + Math.max(-dt * 1.4, Math.min(dt * 1.4, targetNight - amt))));
      const night = nightAmtRef.current;

      // war posts come from last frame's monsters; cleared the moment war ends so everyone walks home
      const heroes = heroesRef.current;
      const monsters = monstersRef.current;
      warPostsRef.current = p.war ? computeWarPosts(world, warPostsRef.current) : new Map();
      const warPosts = warPostsRef.current;

      // ── hero sim ──
      for (const h of heroes.values()) {
        if (h.removing) {
          h.alpha -= dt * 1.6;
          h.moving = false;
          if (h.alpha <= 0) {
            heroes.delete(h.sessionId);
            clearHeroSpot(h.sessionId);
          }
          continue;
        }
        h.alpha = Math.min(1, h.alpha + dt * 2.5);
        syncHeroStatus(h, t);
        // the Simone dragon play moves its hero itself (chase / pet)
        if (!h.dragging && !h.puppet) retarget(h, world, t);
        if (h.puppet) {
          // positions and walk state come from updateDragonPlay
        } else if (h.route.length > 0) {
          let budget = HERO_SPEED * dt;
          while (budget > 0 && h.routeI < h.route.length) {
            const tgt = h.route[h.routeI] as Pt;
            const dx = tgt.x - h.x;
            const dy = tgt.y - h.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= budget) {
              h.x = tgt.x;
              h.y = tgt.y;
              budget -= dist;
              h.routeI++;
            } else {
              h.x += (dx / dist) * budget;
              h.y += (dy / dist) * budget;
              if (Math.abs(dx) > 1) h.facing = dx < 0 ? -1 : 1;
              budget = 0;
            }
          }
          h.walk += HERO_SPEED * dt;
          h.moving = true;
          if (h.routeI >= h.route.length) {
            h.route = [];
            h.moving = false;
            h.arrived = true;
            h.actionT = 0;
            h.nextFidgetAt = t + 1.5 + Math.random() * 3;
            if (h.placeId !== 'tavern') h.facing = 1;
          }
        } else {
          h.moving = false;
          h.arrived = true;
        }
        if (h.arrived && h.status === 'running') h.actionT += dt;
        // tavern fidgets on random timers (not while being carried or drafted)
        const resting = h.arrived && !h.dragging && (h.status === 'done' || h.status === 'idle') && !warPosts.has(h.sessionId);
        if (resting) {
          if (h.fidget && t >= h.fidgetUntil) {
            h.fidget = null;
            h.nextFidgetAt = t + 2 + Math.random() * 4;
          } else if (!h.fidget && t >= h.nextFidgetAt) {
            const kind = FIDGETS[Math.floor(Math.random() * FIDGETS.length)] ?? 'look';
            h.fidget = kind;
            h.fidgetDur = FIDGET_DUR[kind];
            h.fidgetUntil = t + h.fidgetDur;
          }
        } else if (h.fidget) {
          h.fidget = null;
        }
        if (h.pendingBurst && h.alpha > 0.5) {
          h.pendingBurst = false;
          emitSparkBurst(st, { x: h.x, y: h.y - 10 }, '#4ade80', 10, 70);
          emitSparkBurst(st, { x: h.x, y: h.y - 10 }, '#ffd97a', 6, 50);
        }
      }

      // monsters follow the heroes' error state
      updateMonsters(monsters, heroes, world, dt, t, st, (h) => errorSite(h, world)?.at ?? null);
      // WAR practice: heroes standing at their post wear their monster down
      const attackers = new Map<string, Pt[]>();
      const hunters = new Map<string, Pt[]>();
      for (const h of heroes.values()) {
        const post = warPosts.get(h.sessionId);
        if (!post?.foe || h.removing) continue;
        hunters.set(post.foe, [...(hunters.get(post.foe) ?? []), { x: h.x, y: h.y }]);
        if (!h.arrived || h.moving) continue;
        attackers.set(post.foe, [...(attackers.get(post.foe) ?? []), { x: h.x, y: h.y }]);
      }
      const home = world.tavern.plaza?.c ?? { x: WORLD_W / 2, y: WORLD_H / 2 };
      updatePractice(monsters, practiceRef.current, { war: p.war, want: practiceWant(draftees().length), spots: openGround(world, PRACTICE_MARGIN), home, attackers, hunters, world }, dt, t, st);
      // a dodge queued against a monster that has since been slain is called off (no hop, no "miss!" after it falls)
      for (const h of heroes.values()) {
        const src = h.pendingDodge?.src as Partial<Monster> | undefined;
        if (src && src.phase !== undefined && !monsterAlive(src as Monster)) {
          h.pendingDodge = undefined;
          if (h.missAt !== undefined && h.missAt !== null && h.missAt > t) h.missAt = null;
        }
      }
      // a monster swing that started this frame: the nearest hero fighting it dodges
      for (const m of monsters.values()) {
        if (m.attackAt !== t || !monsterAlive(m)) continue;
        let target: Hero | null = null;
        let best = 48;
        for (const h of heroes.values()) {
          if (h.removing || !h.arrived || h.moving) continue;
          const post = warPosts.get(h.sessionId);
          const engaged = post ? post.foe === m.sessionId : h.sessionId === m.sessionId;
          const d = Math.hypot(h.x - m.x, h.y - m.y);
          if (engaged && d < best) {
            best = d;
            target = h;
          }
        }
        if (target) {
          // hop far enough that the hero's body is clear of this monster's swing (attack-frame reach + lunge) at impact;
          // the hop is ~82% complete then, so aim a little past the clearance
          const need = attackClearance(m) - Math.abs(target.x - m.x);
          let dist = Math.max(MIN_DODGE, Math.ceil(need / 0.82));
          // the landing spot must be open ground (never the pond): shorten the hop until it is
          const away = target.x < m.x ? -1 : 1;
          while (dist > 10 && !isWalkable(world, target.x + away * dist, target.y)) dist -= 2;
          startDodge(target, m, t, MONSTER_IMPACT - DODGE_LEAD, false, t + MONSTER_IMPACT, dist);
        }
      }

      // the Simone dragon (a friend, never a foe): a hero working at Simone plays with her (chase -> pet her head
      // -> she sleeps). A real error there is fought like anywhere else; she keeps out of it. In WAR she circles the
      // battle and now and then lands by an idle villager to be petted.
      const lair = world.places.find((g) => g.kind === 'lair') ?? null;
      if (lair) {
        const dp = dragonPlayRef.current;
        const busy = (h: Hero): boolean => {
          const em = monsters.get(h.sessionId);
          return (h.status === 'thinking' || h.status === 'running' || h.status === 'delegating') && !warPosts.has(h.sessionId) && !(em && monsterAlive(em));
        };
        const atLair = [...heroes.values()].filter((h) => !h.removing && h.placeId === lair.id).sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
        // keep the current playmate while it works; a new one joins once it has arrived at Simone
        const cur = dp.heroId ? heroes.get(dp.heroId) : undefined;
        const playHero = p.war ? null : cur && cur.placeId === lair.id && busy(cur) && !cur.removing ? cur : (atLair.find((h) => busy(h) && h.arrived && !h.moving) ?? null);
        const drafted = [...heroes.values()].filter((h) => !h.removing && warPosts.has(h.sessionId));
        const battle = drafted.length ? { x: drafted.reduce((a, h) => a + h.x, 0) / drafted.length, y: drafted.reduce((a, h) => a + h.y, 0) / drafted.length } : { x: WORLD_W / 2, y: WORLD_H / 2 };
        // idle-ish villagers she may visit: standing still, preferring those drilling in formation (no monster of their own)
        const standing = drafted.filter((h) => h.arrived && !h.moving && !h.dragging && !h.removing);
        const drilling = standing.filter((h) => warPosts.get(h.sessionId)?.foe === null);
        const visitable = drilling.length ? drilling : standing;
        const perch = lair.dragon ? { x: lair.dragon.x + 36, y: lair.dragon.y + 48 } : lair.square;
        const door = lair.buildings[0]?.door ?? lair.square;
        preloadDragonPlay();
        updateDragonPlay(
          dp,
          {
            hero: playHero,
            heroes,
            home: perch,
            center: { x: lair.rect.x + lair.rect.w / 2, y: lair.rect.y + lair.rect.h / 2 },
            restSpot: { x: door.x + 26, y: door.y + 2 },
            // the mountain body (upper part of the lair; the cave mouths / yard below stay walkable)
            avoid: { x: lair.rect.x + 24, y: lair.rect.y, w: lair.rect.w - 48, h: Math.max(0, door.y - lair.rect.y - 12) },
            reduced: st.reduced,
            war: p.war,
            battle,
            visitable,
            crowd: [
              ...[...heroes.values()].filter((h) => !h.removing && h.sessionId !== dp.heroId).map((h) => ({ x: h.x, y: h.y })),
              ...[...monsters.values()].filter(monsterAlive).map((m) => ({ x: m.x, y: m.y })),
            ],
            walkable: (x: number, y: number) => isWalkable(world, x, y),
            bodyClear: (r) => bodyClear(world, r),
          },
          dt,
          t,
          st,
        );
        // while she is down (petted / asleep) nobody stands, spawns or fights on her
        const fp = dragonFootprint(dp);
        world.dynamicBlockers = fp ? [fp] : [];
      }
      // busy / your-turn glow targets for the places (2 Hz; heroes are drawn at hero.placeId, your-turn ones rest at the tavern so resolve their project)
      st.life.sinceSummary += dt;
      if (st.life.sinceSummary > 0.5) {
        st.life.sinceSummary = 0;
        summarizeHeroes(st.life, heroes.values(), (h) => resolveAgentPlace(h.agent, getWild())?.place.id ?? null);
      }
      updateAmbient(st, world, dt, t, night);

      // ── draw ──
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#0d1018';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const worldXf = (): void => ctx.setTransform(view.z * dpr, 0, 0, view.z * dpr, view.ox * dpr, view.oy * dpr);
      const screenXf = (): void => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      worldXf();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(world.canvas, 0, 0);
      drawAmbientBack(ctx, st, world, t, night, 'ground');
      if (night > 0.02) {
        ctx.fillStyle = `rgba(18, 26, 58, ${(0.45 * night).toFixed(3)})`;
        ctx.fillRect(0, 0, WORLD_W, WORLD_H);
      }
      drawAmbientBack(ctx, st, world, t, night, 'lights');

      // grid (editor or settings toggle)
      if (p.showGrid || p.editor) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let x = 0; x <= WORLD_W; x += TILE) ctx.fillRect(x, 0, 1, WORLD_H);
        for (let y = 0; y <= WORLD_H; y += TILE) ctx.fillRect(0, y, WORLD_W, 1);
      }
      if (p.editor) {
        for (const g of world.places) {
          const d = pointerRef.current?.drag;
          const dragging = d?.kind === 'place' && d.placeId === g.id;
          drawRectOutline(ctx, g.rect.x - 1, g.rect.y - 1, g.rect.w + 2, g.rect.h + 2, dragging ? '#ffd97a' : 'rgba(255,255,255,0.5)');
        }
      }

      // the dragon on her perch (while she is out she is drawn with the actors below)
      if (lair && !dragonPlayActive(dragonPlayRef.current)) drawDragon(ctx, lair, dragonRef.current, t, dt, st);

      const heroList = [...heroes.values()].filter((h) => h.alpha > 0);
      const monsterList = [...monsters.values()];
      const hoveredKey = hoverRef.current?.key ?? '';
      const isHot = (h: Hero): boolean => hoveredKey === `h:${h.sessionId}` || hoveredKey === `m:${h.sessionId}` || p.selectedSessionId === h.sessionId;
      const isHotMonster = (m: Monster): boolean => hoveredKey === `m:${m.sessionId}` || hoveredKey === `h:${m.sessionId}` || p.selectedSessionId === m.sessionId;
      const fontScale = Math.max(0.9, Math.min(1.5, Math.sqrt(view.z)));
      const px = (n: number): number => Math.round(n * fontScale);
      const plateFont = `bold ${px(8)}px monospace`;

      // ── city banners + building plates: screen space, UNDER the actors; a plate someone stands on fades ──
      screenXf();
      const actorBoxes: Box[] = [];
      for (const h of heroList) {
        const s = toScreen(view, h.x, h.y);
        const hw = 9 * view.z * h.scale;
        actorBoxes.push({ x0: s.x - hw, x1: s.x + hw, y0: s.y - 26 * view.z * h.scale, y1: s.y + 2 });
      }
      for (const m of monsterList) {
        const s = toScreen(view, m.x, m.y);
        actorBoxes.push({ x0: s.x - 12 * view.z, x1: s.x + 12 * view.z, y0: s.y - 34 * view.z, y1: s.y + 2 });
      }
      const coveredBy = (b: Box): boolean => actorBoxes.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
      for (const g of world.places) {
        const b = toScreen(view, g.bannerAt.x, g.bannerAt.y);
        if (b.x < -200 || b.x > cw + 200 || b.y < -60 || b.y > ch + 60) continue;
        const cloth = g.kind === 'city' ? (g.id === 'habits' ? '#b5732a' : '#2e5f9e') : g.kind === 'dungeon' ? '#4a2f4a' : g.kind === 'lair' ? '#7a2f28' : g.kind === 'tavern' ? '#7e2f28' : '#4b5e3a';
        drawBanner(ctx, Math.round(b.x), Math.round(b.y - px(18)), g.name.toUpperCase(), cloth, '#f1e4c8', `bold ${px(11)}px monospace`);
        if (view.z >= 0.55 && g.kind !== 'tavern') {
          // plates alternate between two rows so neighbours in a dense row never collide
          const sorted = [...g.buildings].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
          let rowY = -1;
          let idx = 0;
          for (const bd of sorted) {
            if (bd.rect.y !== rowY) {
              rowY = bd.rect.y;
              idx = 0;
            }
            const s = toScreen(view, bd.rect.x + bd.rect.w / 2, bd.rect.y + bd.rect.h);
            const stagger = view.z < 1.2 ? (idx % 2) * px(12) : 0;
            const w = plateWidth(ctx, bd.name, plateFont);
            const py = Math.round(s.y + 3 + stagger);
            ctx.globalAlpha = coveredBy({ x0: s.x - w / 2, x1: s.x + w / 2, y0: py, y1: py + PLATE_H }) ? 0.35 : 1;
            drawPlate(ctx, Math.round(s.x), py, bd.name, plateFont, hoverRef.current?.key === `b:${g.id}/${bd.repoId}`);
            ctx.globalAlpha = 1;
            idx++;
          }
        }
        if (p.editor) {
          const s = toScreen(view, g.rect.x + g.rect.w / 2, g.rect.y + g.rect.h);
          drawTextOutlined(ctx, g.def.tagline, Math.round(s.x), Math.round(s.y + 4), '#b8c0da', `${px(8)}px monospace`);
        }
      }

      // ── heroes + monsters (painter order by y) ──
      worldXf();
      const heroTops = new Map<string, number>();
      const monsterTops = new Map<string, number>();
      // faint dotted tether from a hovered / selected squire to its knight
      for (const h of heroList) {
        const parent = isHot(h) ? parentOf(h) : null;
        if (!parent) continue;
        const dx = parent.x - h.x;
        const dy = parent.y - h.y;
        const n = Math.max(2, Math.floor(Math.hypot(dx, dy) / 4));
        ctx.fillStyle = `rgba(255,240,200,${(0.55 * h.alpha).toFixed(3)})`;
        for (let i = 1; i < n; i++) ctx.fillRect(Math.round(h.x + (dx * i) / n), Math.round(h.y - 1 + (dy * i) / n), 1, 1);
      }
      /** The monster a hero squares up to: its war target, else its own error's monster (while it lives). */
      const foeFor = (h: Hero): Foe | null => {
        const post = warPosts.get(h.sessionId);
        const id = post ? post.foe : h.agent.lastError ? h.sessionId : null;
        if (!id) return null;
        const m = monsters.get(id);
        return m && monsterAlive(m) ? { ...monsterCentre(m), fy: m.y } : null;
      };
      const dpl = dragonPlayRef.current;
      const playing = dragonPlayActive(dpl);
      const walkableAt = (x: number, y: number): boolean => isWalkable(world, x, y);
      const drawables = [
        ...heroList.map((h) => ({ y: h.y, hero: h, monster: null as Monster | null, dragon: false })),
        ...monsterList.map((m) => ({ y: m.y, hero: null as Hero | null, monster: m, dragon: false })),
        ...(playing ? [{ y: dragonPlaySortY(dpl), hero: null as Hero | null, monster: null as Monster | null, dragon: true }] : []),
      ].sort((a, b) => a.y - b.y);
      for (const d of drawables) {
        if (d.dragon) {
          ctx.globalAlpha = p.editor ? 0.35 : 1;
          drawDragonPlay(ctx, dpl, t);
        } else if (d.hero) {
          const h = d.hero;
          ctx.globalAlpha = h.alpha * (p.editor ? 0.35 : 1);
          const post = warPosts.get(h.sessionId);
          const foeId = post ? post.foe : h.agent.lastError ? h.sessionId : null;
          const onStrike = foeId
            ? (): void => {
                const fm = monsters.get(foeId);
                if (fm) strikeMonster(fm, t);
              }
            : undefined;
          const top = drawHero(ctx, h, t, dt, st, { selected: p.selectedSessionId === h.sessionId, foe: foeFor(h), drill: post !== undefined && post.foe === null, onStrike, pet: petFacing(dpl, h.sessionId), walkable: walkableAt });
          heroTops.set(h.sessionId, top);
          const typing = typingRef.current.get(h.sessionId);
          if (typing && !typing.sent && t - typing.at < TYPING_HOLD) drawTypingBubble(ctx, h.x + 8 * h.scale, top - 2, t);
        } else if (d.monster) {
          const m = d.monster;
          ctx.globalAlpha = p.editor ? 0.35 : 1;
          const r = drawMonster(ctx, m, t, dt, st, isHotMonster(m));
          monsterTops.set(m.sessionId, r.top);
        }
        ctx.globalAlpha = 1;
      }

      if (dragonPlayActive(dpl)) drawDragonFx(ctx, dpl, t, st.reduced);
      drawAmbientFront(ctx, st, world, t, night);

      // "discovered!" sparkle rings over freshly popped wild places
      fxRef.current = fxRef.current.filter((f) => t - f.t0 < 2.6);
      for (const f of fxRef.current) {
        const g = world.byId.get(f.placeId);
        if (!g) continue;
        const k = (t - f.t0) / 2.6;
        const c = { x: g.rect.x + g.rect.w / 2, y: g.rect.y + 52 };
        if (k < 0.1 && Math.random() < 0.5) emitSparkBurst(st, c, '#ffd97a', 4, 90);
        ctx.strokeStyle = `rgba(255,230,140,${(1 - k).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y + 10, 20 + k * 60, (20 + k * 60) * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ── screen-space overlays ──
      screenXf();
      if (night > 0.02) {
        for (const s of stars) {
          const tw = 0.25 + 0.55 * Math.abs(Math.sin(t * 1.3 + s.phase));
          ctx.fillStyle = `rgba(235,240,255,${(tw * night * 0.8).toFixed(3)})`;
          ctx.fillRect(Math.round(s.fx * cw), Math.round(s.fy * ch), s.size, s.size);
        }
      }
      // hero labels: each label takes the first free row above its hero (no overlaps; monsters are claimed first)
      const placed: Box[] = [];
      for (const m of monsterList) {
        // reserve the monster's whole prowl box (its stand point +-8 px), so hero labels don't hop rows as it paces
        const s = toScreen(view, m.base.x, m.y);
        const top = toScreen(view, m.base.x, monsterTops.get(m.sessionId) ?? m.y - 24);
        placed.push({ x0: s.x - 22 * view.z, x1: s.x + 22 * view.z, y0: top.y - 2, y1: s.y + 2 });
      }
      const labelFont = `bold ${px(9)}px monospace`;
      const rowH = px(11);
      const bubbles: Array<{ h: Hero; x: number; y: number }> = [];
      ctx.font = labelFont;
      const sortedHeroes = [...heroList].sort((a, b) => a.y - b.y);
      for (const h of sortedHeroes) {
        const top = heroTops.get(h.sessionId) ?? h.y - 16;
        const s = toScreen(view, h.x, top);
        const bubble = h.status === 'error' || (h.arrived && !h.moving && (h.status === 'running' || h.status === 'thinking'));
        // working heroes carry Claude Code's spinner verb ("Sketching…") in a small caption under the name
        const workingNow = !h.removing && (h.status === 'running' || h.status === 'thinking');
        const capH = workingNow ? px(8) : 0;
        const baseY = Math.round(s.y - (bubble ? 34 * Math.max(0.6, view.z) : 10) - 4 - capH);
        ctx.font = labelFont;
        const tw = ctx.measureText(h.label).width + 6;
        let labelY = baseY;
        for (let row = 0; row < 12; row++) {
          labelY = baseY - row * rowH;
          const box = { x0: s.x - tw / 2, x1: s.x + tw / 2, y0: labelY, y1: labelY + rowH + capH };
          const clash = placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0);
          if (!clash) {
            placed.push(box);
            break;
          }
        }
        ctx.globalAlpha = h.alpha * (p.editor ? 0.5 : 1);
        const selected = p.selectedSessionId === h.sessionId;
        drawTextOutlined(ctx, h.label, Math.round(s.x), labelY, selected ? '#fff6d5' : '#f4ead0', labelFont, selected ? '#5d4524' : '#1a1410');
        if (workingNow) {
          const phase = (Date.now() % VERB_PERIOD_MS) / VERB_PERIOD_MS;
          const fade = Math.max(0, Math.min(1, phase / 0.06, (1 - phase) / 0.06));
          ctx.globalAlpha = h.alpha * fade * (p.editor ? 0.5 : 0.92);
          drawTextOutlined(ctx, `${spinnerVerb(h.seed)}…`, Math.round(s.x), labelY + rowH - px(1), '#cfe0ff', `italic ${px(7)}px monospace`);
          ctx.globalAlpha = h.alpha * (p.editor ? 0.5 : 1);
          ctx.font = labelFont;
        }
        if (isHot(h)) bubbles.push({ h, x: Math.round(s.x), y: labelY - px(2) });
        if (h.status === 'idle' && h.arrived && !warPosts.has(h.sessionId)) {
          for (let i = 0; i < 3; i++) {
            const k = (t * 0.45 + i * 0.33) % 1;
            ctx.globalAlpha = h.alpha * (1 - k);
            drawTextOutlined(ctx, 'z', Math.round(s.x + 8 + k * 14 * fontScale), Math.round(s.y - 6 - k * 22 * fontScale), '#d7dce8', `bold ${px(7 + i)}px monospace`);
          }
        }
        ctx.globalAlpha = 1;
      }
      // monster plates: "👾 <tool>" on scorched wood under each monster
      for (const m of monsterList) {
        const s = toScreen(view, m.x, m.y);
        ctx.globalAlpha = (m.phase === 'dying' ? Math.max(0, 1 - m.phaseT / 0.6) : 1) * (p.editor ? 0.5 : 1);
        // the hero stands at sword's reach: the plate hangs away from it so it never sits under the hero's feet
        const text = monsterPlateText(m);
        const shift = m.side * Math.max(0, plateWidth(ctx, text, plateFont) / 2 - 10);
        drawPlate(ctx, Math.round(s.x + shift), Math.round(s.y + 4), text, plateFont, isHotMonster(m), true);
        ctx.globalAlpha = 1;
      }
      // what the hovered / selected hero is up to (or the error it is fighting), on parchment above its name — drawn last so it sits on top
      for (const b of bubbles) {
        ctx.globalAlpha = b.h.alpha * (p.editor ? 0.5 : 1);
        drawSpeechBubble(ctx, b.x, b.y, bubbleLine({ ...b.h.agent, status: b.h.status }, warPosts.has(b.h.sessionId)), `${px(8)}px monospace`, fontScale);
        ctx.globalAlpha = 1;
      }
      for (const f of fxRef.current) {
        const g = world.byId.get(f.placeId);
        if (!g) continue;
        const k = (t - f.t0) / 2.6;
        const s = toScreen(view, g.rect.x + g.rect.w / 2, g.rect.y + 30);
        ctx.globalAlpha = Math.min(1, (1 - k) * 2);
        drawTextOutlined(ctx, 'Discovered!', Math.round(s.x), Math.round(s.y - 30 - k * 30), '#ffe9a6', `bold ${px(12)}px monospace`);
        ctx.globalAlpha = 1;
      }

      // empty states
      if (p.connection === 'online') {
        if (p.claudeDirs.length === 0) {
          drawParchment(ctx, cw / 2, ch / 2 - 10, 'No ~/.claude installation detected', 'Is Claude Code installed on this machine?', true);
        } else if (p.agents.length === 0 && heroes.size === 0) {
          drawParchment(ctx, cw / 2, ch - 48, 'The realm is quiet', 'Start a Claude Code session to see heroes leave the tavern', false);
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── hit-testing ──
  const screenPoint = (e: { clientX: number; clientY: number }): { sx: number; sy: number } => {
    const cv = canvasRef.current;
    if (!cv) return { sx: 0, sy: 0 };
    const rect = cv.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const hitTest = (sx: number, sy: number): Hit => {
    const world = worldRef.current?.world;
    if (!world) return null;
    const view = viewRef.current;
    const w = toWorld(view, sx, sy);
    const r = Math.max(12, 10 / view.z);
    let best: Hero | null = null;
    let bestD = r * r;
    for (const h of heroesRef.current.values()) {
      if (h.removing) continue;
      const d = (h.x - w.x) ** 2 + (h.y - 8 - w.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (best) return { kind: 'hero', hero: best };
    for (const m of monstersRef.current.values()) {
      if (monsterAlive(m) && monsterHit(m, w.x, w.y, r + 2)) return { kind: 'monster', monster: m };
    }
    const ordered = [...world.places].sort((a, b) => b.rect.y - a.rect.y);
    for (const place of ordered) {
      for (const building of place.buildings) {
        if (inRect(w.x, w.y, building.rect)) return { kind: 'building', place, building };
      }
    }
    for (const place of ordered) {
      if (inRect(w.x, w.y, place.rect)) return { kind: 'place', place };
    }
    return null;
  };

  const hitPlace = (sx: number, sy: number): PlaceGeom | null => {
    const world = worldRef.current?.world;
    if (!world) return null;
    const w = toWorld(viewRef.current, sx, sy);
    const ordered = [...world.places].sort((a, b) => b.rect.y - a.rect.y);
    return ordered.find((g) => inRect(w.x, w.y, g.rect)) ?? null;
  };

  const hitKey = (hit: Hit): string => {
    if (!hit) return '';
    if (hit.kind === 'hero') return `h:${hit.hero.sessionId}`;
    if (hit.kind === 'monster') return `m:${hit.monster.sessionId}`;
    if (hit.kind === 'building') return `b:${hit.place.id}/${hit.building.repoId}`;
    return `p:${hit.place.id}`;
  };

  /** Hero / monster hover shows the canvas speech bubble instead of a DOM tooltip. Returns the hit for cursor choice. */
  const updateHover = (sx: number, sy: number): Hit => {
    const hit = hitTest(sx, sy);
    const key = hitKey(hit);
    const tip = tooltipRef.current;
    if (tip) {
      // flip to the left of the cursor near the right edge so the box is never clipped
      const flip = sx + 14 + 330 > sizeRef.current.cw;
      tip.style.transform = flip
        ? `translate(calc(${Math.round(sx - 14)}px - 100%), ${Math.round(sy + 16)}px)`
        : `translate(${Math.round(sx + 14)}px, ${Math.round(sy + 16)}px)`;
    }
    if (hoverRef.current?.key === key) return hit;
    hoverRef.current = key ? { key, sx, sy } : null;
    if (!hit || hit.kind === 'hero' || hit.kind === 'monster') {
      setTooltip(null);
    } else if (hit.kind === 'building') {
      setTooltip({ key, title: hit.building.name, sub: `${hit.place.name} — ${hit.place.def.tagline}` });
    } else {
      setTooltip({ key, title: hit.place.name, sub: hit.place.def.tagline });
    }
    return hit;
  };

  // ── pointer handling: click / pan / editor drag / hero drag ──
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (pointerRef.current) return; // a second pointer must not clobber the first
    const { sx, sy } = screenPoint(e);
    const p = propsRef.current;
    let drag: Drag | null = null;
    if (p.editor) {
      const g = hitPlace(sx, sy);
      if (g) {
        const w = toWorld(viewRef.current, sx, sy);
        drag = { kind: 'place', placeId: g.id, offX: w.x - g.rect.x, offY: w.y - g.rect.y };
      }
    } else {
      // heroes are hit-tested first, so an idle hero under the pointer is carried rather than panning the map
      const hit = hitTest(sx, sy);
      if (hit?.kind === 'hero' && canDragHero(hit.hero, parentOf(hit.hero) !== null)) {
        const w = toWorld(viewRef.current, sx, sy);
        drag = { kind: 'hero', sessionId: hit.hero.sessionId, offX: w.x - hit.hero.x, offY: w.y - hit.hero.y };
      }
    }
    pointerRef.current = { pointerId: e.pointerId, sx, sy, moved: false, startView: { ...viewRef.current }, drag };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const { sx, sy } = screenPoint(e);
    const ps = pointerRef.current;
    const cv = e.currentTarget;
    if (!ps) {
      const hit = updateHover(sx, sy);
      if (propsRef.current.editor) cv.style.cursor = hitPlace(sx, sy) ? 'grab' : 'default';
      else if (hit?.kind === 'hero') cv.style.cursor = canDragHero(hit.hero, parentOf(hit.hero) !== null) ? 'grab' : 'pointer';
      else cv.style.cursor = hit ? 'pointer' : 'default';
      return;
    }
    if (e.pointerId !== ps.pointerId) return;
    if (!ps.moved && Math.hypot(sx - ps.sx, sy - ps.sy) > 4) ps.moved = true;
    if (!ps.moved) return;
    if (ps.drag?.kind === 'hero') {
      const h = heroesRef.current.get(ps.drag.sessionId);
      const world = worldRef.current?.world;
      if (!h || !world) return;
      cv.style.cursor = 'grabbing';
      const w = toWorld(viewRef.current, sx, sy);
      const pt = clampToPlaza(world.tavern, { x: w.x - ps.drag.offX, y: w.y - ps.drag.offY });
      h.dragging = true;
      h.route = [];
      h.moving = false;
      h.arrived = true;
      h.fidget = null;
      h.x = pt.x;
      h.y = pt.y;
      h.spot = pt; // squires follow live
      if (tooltipRef.current) setTooltip(null);
      return;
    }
    if (ps.drag) {
      cv.style.cursor = 'grabbing';
      const world = worldRef.current?.world;
      const g = world?.byId.get(ps.drag.placeId);
      if (!world || !g) return;
      const w = toWorld(viewRef.current, sx, sy);
      const fp = footprintFor(g.kind, g.id);
      const tx = Math.max(0, Math.min(TILES_X - fp.tw, Math.round((w.x - ps.drag.offX) / TILE)));
      const ty = Math.max(0, Math.min(TILES_Y - fp.th, Math.round((w.y - ps.drag.offY) / TILE)));
      if (g.tile.tx === tx && g.tile.ty === ty) return;
      const next = { x: tx, y: ty, w: fp.tw, h: fp.th };
      for (const o of world.places) {
        if (o.id === g.id) continue;
        const ofp = footprintFor(o.kind, o.id);
        if (rectsOverlap(next, { x: o.tile.tx, y: o.tile.ty, w: ofp.tw, h: ofp.th })) return;
      }
      propsRef.current.onLayoutChange({ ...propsRef.current.layout, [g.id]: { tx, ty } });
      return;
    }
    cv.style.cursor = 'grabbing';
    camAnimRef.current = null;
    fitLockRef.current = false;
    const { cw, ch } = sizeRef.current;
    viewRef.current = clampView({ z: ps.startView.z, ox: ps.startView.ox + (sx - ps.sx), oy: ps.startView.oy + (sy - ps.sy) }, cw, ch);
    if (tooltipRef.current) setTooltip(null);
  };

  /** Ends a hero drag: the hero stays put and, if it moved, the spot is remembered for the session. */
  const dropHero = (drag: Drag | null, moved: boolean): boolean => {
    if (drag?.kind !== 'hero') return false;
    const h = heroesRef.current.get(drag.sessionId);
    if (!h) return false;
    h.dragging = false;
    if (!moved) return true;
    h.spot = { x: h.x, y: h.y };
    const plaza = worldRef.current?.world.tavern.plaza;
    if (plaza) {
      h.restOffset = { x: h.x - plaza.c.x, y: h.y - plaza.c.y };
      saveHeroSpot(h.sessionId, h.restOffset);
    }
    return true;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const ps = pointerRef.current;
    if (!ps || e.pointerId !== ps.pointerId) return;
    pointerRef.current = null;
    const heroDrop = dropHero(ps.drag, ps.moved);
    e.currentTarget.style.cursor = heroDrop ? 'grab' : 'default';
    if (ps.moved) return; // a drag (map pan, place or hero) never counts as a click
    const { sx, sy } = screenPoint(e);
    const p = propsRef.current;
    const hit = hitTest(sx, sy);
    if (!hit) return;
    if (hit.kind === 'hero') p.onSelectAgent(hit.hero.sessionId);
    else if (hit.kind === 'monster') {
      if (!hit.monster.simulated) p.onSelectAgent(hit.monster.sessionId); // a real monster stands for its hero's error
    }
    else if (hit.kind === 'building') p.onSelectPlace(hit.place.id, hit.place.kind === 'tavern' ? null : hit.building.repoId);
    else p.onSelectPlace(hit.place.id, null);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const ps = pointerRef.current;
    if (ps?.pointerId === e.pointerId) {
      pointerRef.current = null;
      dropHero(ps.drag, ps.moved);
    }
    e.currentTarget.style.cursor = 'default';
  };

  const onPointerLeave = (): void => {
    hoverRef.current = null;
    setTooltip(null);
  };

  // Dev aid for headless checks: hero / monster positions + the camera, read via page.evaluate.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as Window & { __rtsVillage?: unknown };
    w.__rtsVillage = {
      heroes: () =>
        [...heroesRef.current.values()].map((h) => ({ sessionId: h.sessionId, label: h.label, x: h.x, y: h.y, status: h.status, placeId: h.placeId, arrived: h.arrived, moving: h.moving, spot: h.spot, warPost: warPostsRef.current.get(h.sessionId) ?? null, dodgeAt: h.dodgeAt ?? null, pendingDodge: h.pendingDodge ?? null, dodgeFrom: h.dodgeFrom ?? null, dodgeDir: h.dodgeDir ?? null, dodgeDist: h.dodgeDist ?? null })),
      monsters: () =>
        [...monstersRef.current.values()].map((m) => ({ sessionId: m.sessionId, kind: m.kind, tool: m.tool, x: m.x, y: m.y, side: m.side, phase: m.phase, simulated: m.simulated, damage: m.damage, toughness: m.toughness, flinchAt: m.flinchAt, attackAt: m.attackAt, anchor: m.anchor, lastMovedAt: m.lastMovedAt, clearance: attackClearance(m) })),
      view: () => ({ ...viewRef.current }),
      walkable: (x: number, y: number) => isWalkable(getWorld(), x, y, 0),
      dragonBodyClear: (x: number, y: number) => bodyClear(getWorld(), { x: x - 40, y: y - 50, w: 80, h: 54 }),
      dragon: () => { const d = dragonPlayRef.current; return { phase: d.phase, phaseT: d.phaseT, x: d.x, y: d.y, z: d.z, heroId: d.heroId, chaseDur: d.chaseDur, mode: d.mode, to: d.to, fx: d.fx.map((f) => f.kind), sleepDur: d.sleepDur }; },
      fit: () => {
        const { cw, ch } = sizeRef.current;
        camAnimRef.current = null;
        fitLockRef.current = true;
        viewRef.current = fitView(cw, ch);
      },
    };
    return () => {
      delete w.__rtsVillage;
    };
  }, []);

  const onDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>): void => {
    const { sx, sy } = screenPoint(e);
    const hit = hitTest(sx, sy);
    if (!hit || hit.kind !== 'hero') return;
    const { cw, ch } = sizeRef.current;
    fitLockRef.current = false;
    animateTo(centerOn(hit.hero.x, hit.hero.y - 8, Math.min(MAX_ZOOM, Math.max(viewRef.current.z, 2)), cw, ch));
  };

  return (
    <div ref={wrapRef} className="village-wrap">
      <canvas
        ref={canvasRef}
        className="village-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />
      <div ref={tooltipRef} className={`village-tooltip ${tooltip ? 'village-tooltip-on' : ''}`} aria-hidden={!tooltip}>
        {tooltip && (
          <>
            <div className="village-tooltip-title">{tooltip.title}</div>
            <div className="village-tooltip-sub">{tooltip.sub}</div>
          </>
        )}
      </div>
    </div>
  );
}
