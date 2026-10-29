// The world canvas: a 96x60-tile map with the tavern plaza in the centre and
// the user's projects around it (cities, dungeon, dragon lair, wild spots).
// Heroes walk the roads from the tavern to their repo and act out their tool.
// Static art is pre-rendered once per layout (world/terrain.ts); each frame
// only draws sprites, particles and labels. Camera: wheel zoom + drag pan.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { AgentState, ConnectionStatus } from '../types/agent';
import { STATUS_COLORS, hashString, heroColorIndex, toolToBuilding } from '../utils/spriteMapper';
import { flavorLine } from '../utils/flavor';
import { allPlaces, isRootCwd, loadWildPlaces, rememberWildPlace, resolveAgentPlace } from '../world/registry';
import type { WildPlace } from '../world/registry';
import { HERO_SPEED, TILE, TILES_X, TILES_Y, WORLD_H, WORLD_W, footprintFor } from '../world/constants';
import { MAX_ZOOM, centerOn, clampView, fitView, toScreen, toWorld, zoomAt } from '../world/camera';
import type { View } from '../world/camera';
import { buildWorld } from '../world/terrain';
import type { World } from '../world/terrain';
import { createAmbient, drawAmbientBack, drawAmbientFront, emitSparkBurst, updateAmbient } from '../world/ambient';
import type { AmbientState } from '../world/ambient';
import { drawDragon, drawHero, fightInfo, isWorking, updateDragon } from '../world/actors';
import type { DragonState, FidgetKind, Hero } from '../world/actors';
import type { BuildingGeom, PlaceGeom } from '../world/places';
import { nearestIndex, inRect, rectsOverlap } from '../world/geometry';
import { drawBanner, drawParchment, drawPlate, drawRectOutline, drawTextOutlined, mulberry32 } from '../world/pixel';
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
}

const CAM_EASE_MS = 300;
const FIDGETS: FidgetKind[] = ['look', 'stretch', 'sip', 'hop', 'look'];
const FIDGET_DUR: Record<FidgetKind, number> = { look: 0.7, stretch: 0.9, sip: 1.2, hop: 0.35 };

interface Tooltip {
  key: string;
  title: string;
  sub: string;
}

interface PointerState {
  pointerId: number;
  sx: number;
  sy: number;
  moved: boolean;
  startView: View;
  drag: { placeId: string; offX: number; offY: number } | null;
}

interface DiscoverFx {
  placeId: string;
  t0: number;
}

type Hit = { kind: 'hero'; hero: Hero } | { kind: 'building'; place: PlaceGeom; building: BuildingGeom } | { kind: 'place'; place: PlaceGeom } | null;

function heroLabel(a: AgentState): string {
  if (a.customTitle) return a.customTitle;
  if (a.title) return a.title.length > 18 ? `${a.title.slice(0, 17)}…` : a.title;
  return a.shortId;
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
  const worldRef = useRef<{ key: string; world: World } | null>(null);
  // Lazily initialised once (plain useRef(init()) would re-run init on every render).
  const wildRef = useRef<WildPlace[] | null>(null);
  if (wildRef.current === null) wildRef.current = loadWildPlaces();
  const wildVersionRef = useRef(0);
  const ambientRef = useRef<AmbientState | null>(null);
  if (ambientRef.current === null) {
    ambientRef.current = createAmbient(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  const dragonRef = useRef<DragonState>({ phase: 'idle', phaseT: 0, nextPuffAt: 3 });
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
          x: door.x + ((seed % 9) - 4),
          y: door.y + 2,
          colorIdx: heroColorIndex(a.sessionId),
          seed,
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
      if (h.status !== 'done' && a.status === 'done') h.pendingBurst = true;
      h.shortId = a.shortId;
      h.label = heroLabel(a);
      h.agent = a;
      h.status = a.status;
      h.category = toolToBuilding(a.tool, a.status);
      h.removing = false;
    }
    for (const h of heroes.values()) {
      if (!seen.has(h.sessionId)) h.removing = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.agents]);

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
      animateTo(centerOn(c.x, c.y, 2, cw, ch));
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
  const spotFor = (h: Hero, world: World): Pt => {
    const g = world.byId.get(h.placeId) ?? world.tavern;
    const spreadX = ((h.seed % 7) - 3) * 5;
    const spreadY = ((h.seed >>> 4) % 3) * 4;
    if (g.kind === 'tavern' && g.plaza) {
      const a = (0.15 + ((h.seed >>> 6) % 100) / 100 * 0.7) * Math.PI; // lower half of the plaza
      const r = 26 + ((h.seed >>> 8) % 24);
      return { x: g.plaza.c.x + Math.cos(a) * r, y: g.plaza.c.y + Math.sin(a) * r * 0.82 + 6 };
    }
    const b = h.repoId ? g.buildings.find((bb) => bb.repoId === h.repoId) : null;
    if (b) return { x: b.door.x + spreadX, y: b.door.y + spreadY };
    return { x: g.square.x + spreadX, y: g.square.y + spreadY };
  };

  const retarget = (h: Hero, world: World, t: number): void => {
    const a = h.agent;
    let placeId = 'tavern';
    let repoId: string | null = null;
    if (a.status !== 'idle' && a.status !== 'done') {
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
      }
    }
    const key = `${placeId}/${repoId ?? ''}`;
    if (key === h.targetKey && h.worldKey === worldRef.current?.key) return;
    const w = worldRef.current?.key !== h.worldKey ? getWorld() : world;
    h.targetKey = key;
    h.worldKey = worldRef.current?.key ?? '';
    h.placeId = placeId;
    h.repoId = repoId;
    h.placeKind = w.byId.get(placeId)?.kind ?? 'tavern';
    h.arrived = false;
    // Route: back down the current road to the plaza, then up the target's road, then to the spot.
    const pts: Pt[] = [];
    if (h.roadId && h.roadId !== placeId) {
      const road = w.roads.main.get(h.roadId);
      if (road) {
        const i = nearestIndex(road.pts, h.x, h.y);
        pts.push(...road.pts.slice(0, i + 1).reverse());
      }
      h.roadId = null;
    }
    if (placeId !== 'tavern') {
      const road = w.roads.main.get(placeId);
      if (road) {
        const i = h.roadId === placeId ? nearestIndex(road.pts, h.x, h.y) : 0;
        pts.push(...road.pts.slice(i));
      }
      h.roadId = placeId;
    }
    pts.push(spotFor(h, w));
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

      // ── hero sim ──
      const heroes = heroesRef.current;
      for (const h of heroes.values()) {
        if (h.removing) {
          h.alpha -= dt * 1.6;
          h.moving = false;
          if (h.alpha <= 0) heroes.delete(h.sessionId);
          continue;
        }
        h.alpha = Math.min(1, h.alpha + dt * 2.5);
        retarget(h, world, t);
        if (h.route.length > 0) {
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
        // tavern fidgets on random timers
        const resting = h.arrived && (h.status === 'done' || h.status === 'idle');
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

      // dragon fight state: any working hero standing at the lair
      const lair = world.places.find((g) => g.kind === 'lair') ?? null;
      let fightTarget: Hero | null = null;
      if (lair) {
        for (const h of heroes.values()) {
          if (!h.removing && h.placeId === lair.id && h.arrived && !h.moving && isWorking(h.status)) {
            fightTarget = h;
            break;
          }
        }
      }
      updateDragon(dragonRef.current, dt, t, fightTarget !== null);
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
          const dragging = pointerRef.current?.drag?.placeId === g.id;
          drawRectOutline(ctx, g.rect.x - 1, g.rect.y - 1, g.rect.w + 2, g.rect.h + 2, dragging ? '#ffd97a' : 'rgba(255,255,255,0.5)');
        }
      }

      // the dragon
      if (lair) drawDragon(ctx, lair, dragonRef.current, t, dt, st, fightTarget ? { x: fightTarget.x, y: fightTarget.y - 8 } : null);

      // heroes (painter order by y)
      const heroList = [...heroes.values()].filter((h) => h.alpha > 0).sort((a, b) => a.y - b.y);
      const heroTops = new Map<string, number>();
      for (const h of heroList) {
        ctx.globalAlpha = h.alpha * (p.editor ? 0.35 : 1);
        const fight = lair && h.placeId === lair.id ? fightInfo(dragonRef.current) : null;
        const top = drawHero(ctx, h, t, dt, st, fight, p.selectedSessionId === h.sessionId);
        heroTops.set(h.sessionId, top);
        ctx.globalAlpha = 1;
      }

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
      const fontScale = Math.max(0.9, Math.min(1.5, Math.sqrt(view.z)));
      const px = (n: number): number => Math.round(n * fontScale);
      // city banners + building plates
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
            drawPlate(ctx, Math.round(s.x), Math.round(s.y + 3 + stagger), bd.name, `bold ${px(8)}px monospace`, hoverRef.current?.key === `b:${g.id}/${bd.repoId}`);
            idx++;
          }
        }
        if (p.editor) {
          const s = toScreen(view, g.rect.x + g.rect.w / 2, g.rect.y + g.rect.h);
          drawTextOutlined(ctx, g.def.tagline, Math.round(s.x), Math.round(s.y + 4), '#b8c0da', `${px(8)}px monospace`);
        }
      }
      // hero labels: each label takes the first free row above its hero (no overlaps)
      const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
      const labelFont = `bold ${px(9)}px monospace`;
      const rowH = px(11);
      ctx.font = labelFont;
      for (const h of heroList) {
        const top = heroTops.get(h.sessionId) ?? h.y - 16;
        const s = toScreen(view, h.x, top);
        const foot = toScreen(view, h.x, h.y);
        const bubble = h.status === 'error' || (h.arrived && !h.moving && (h.status === 'running' || h.status === 'thinking'));
        const baseY = Math.round(s.y - (bubble ? 34 * Math.max(0.6, view.z) : 10) - 4);
        const tw = ctx.measureText(h.label).width + 6;
        let labelY = baseY;
        for (let row = 0; row < 12; row++) {
          labelY = baseY - row * rowH;
          const box = { x0: s.x - tw / 2, x1: s.x + tw / 2, y0: labelY, y1: labelY + rowH };
          const clash = placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0);
          if (!clash) {
            placed.push(box);
            break;
          }
        }
        ctx.globalAlpha = h.alpha * (p.editor ? 0.5 : 1);
        const selected = p.selectedSessionId === h.sessionId;
        drawTextOutlined(ctx, h.label, Math.round(s.x), labelY, selected ? '#fff6d5' : '#f4ead0', labelFont, selected ? '#5d4524' : '#1a1410');
        drawTextOutlined(ctx, h.status, Math.round(foot.x), Math.round(foot.y + 3), STATUS_COLORS[h.status], `bold ${px(8)}px monospace`);
        if (h.status === 'idle' && h.arrived) {
          for (let i = 0; i < 3; i++) {
            const k = (t * 0.45 + i * 0.33) % 1;
            ctx.globalAlpha = h.alpha * (1 - k);
            drawTextOutlined(ctx, 'z', Math.round(s.x + 8 + k * 14 * fontScale), Math.round(s.y - 6 - k * 22 * fontScale), '#d7dce8', `bold ${px(7 + i)}px monospace`);
          }
        }
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
    if (hit.kind === 'building') return `b:${hit.place.id}/${hit.building.repoId}`;
    return `p:${hit.place.id}`;
  };

  const updateHover = (sx: number, sy: number): void => {
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
    if (hoverRef.current?.key === key) return;
    hoverRef.current = key ? { key, sx, sy } : null;
    if (!hit) {
      setTooltip(null);
      return;
    }
    if (hit.kind === 'hero') {
      const a = hit.hero.agent;
      setTooltip({ key, title: hit.hero.label, sub: `${flavorLine(a)}  ·  ${a.status}${a.gitBranch ? `  ·  ${a.gitBranch}` : ''}` });
    } else if (hit.kind === 'building') {
      setTooltip({ key, title: hit.building.name, sub: `${hit.place.name} — ${hit.place.def.tagline}` });
    } else {
      setTooltip({ key, title: hit.place.name, sub: hit.place.def.tagline });
    }
  };

  // ── pointer handling: click / pan / editor drag ──
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (pointerRef.current) return; // a second pointer must not clobber the first
    const { sx, sy } = screenPoint(e);
    const p = propsRef.current;
    let drag: PointerState['drag'] = null;
    if (p.editor) {
      const g = hitPlace(sx, sy);
      if (g) {
        const w = toWorld(viewRef.current, sx, sy);
        drag = { placeId: g.id, offX: w.x - g.rect.x, offY: w.y - g.rect.y };
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
      updateHover(sx, sy);
      const hit = hoverRef.current?.key ?? '';
      cv.style.cursor = propsRef.current.editor ? (hitPlace(sx, sy) ? 'grab' : 'default') : hit ? 'pointer' : 'default';
      return;
    }
    if (e.pointerId !== ps.pointerId) return;
    if (!ps.moved && Math.hypot(sx - ps.sx, sy - ps.sy) > 4) ps.moved = true;
    if (!ps.moved) return;
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

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const ps = pointerRef.current;
    if (!ps || e.pointerId !== ps.pointerId) return;
    pointerRef.current = null;
    e.currentTarget.style.cursor = 'default';
    if (ps.moved) return;
    const { sx, sy } = screenPoint(e);
    const p = propsRef.current;
    const hit = hitTest(sx, sy);
    if (!hit) return;
    if (hit.kind === 'hero') p.onSelectAgent(hit.hero.sessionId);
    else if (hit.kind === 'building') p.onSelectPlace(hit.place.id, hit.place.kind === 'tavern' ? null : hit.building.repoId);
    else p.onSelectPlace(hit.place.id, null);
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (pointerRef.current?.pointerId === e.pointerId) pointerRef.current = null;
    e.currentTarget.style.cursor = 'default';
  };

  const onPointerLeave = (): void => {
    hoverRef.current = null;
    setTooltip(null);
  };

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
