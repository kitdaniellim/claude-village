// Live actors: the hero (walk cycle, tavern fidgets, tool-flavoured action
// loops, status bubbles) and the lair dragon (idle breathing / fight loop).
// Everything here draws in world coordinates.

import type { AgentState, AgentStatus, BuildingId } from '../types/agent';
import type { PlaceKind } from './registry';
import { emitSparkBurst, spawn } from './ambient';
import type { AmbientState } from './ambient';
import type { PlaceGeom } from './places';
import { drawPixelEllipse, drawPixelRing } from './pixel';
import type { Pt } from './pixel';
import { dragonPart, dragonSilhouette, heroSprite, iconSprite, propSprite } from './sprites';
import type { HeroPose, PropId } from './sprites';

export type FidgetKind = 'look' | 'stretch' | 'sip' | 'hop';

export interface Hero {
  sessionId: string;
  shortId: string;
  label: string;
  agent: AgentState;
  status: AgentStatus;
  category: BuildingId | null;
  placeId: string;
  repoId: string | null;
  placeKind: PlaceKind;
  targetKey: string;
  worldKey: string;
  x: number;
  y: number;
  colorIdx: number;
  seed: number;
  route: Pt[];
  routeI: number;
  roadId: string | null;
  arrived: boolean;
  walk: number;
  moving: boolean;
  facing: 1 | -1;
  alpha: number;
  removing: boolean;
  pulseUntil: number;
  fidget: FidgetKind | null;
  fidgetUntil: number;
  fidgetDur: number;
  nextFidgetAt: number;
  actionT: number;
  pendingBurst: boolean;
}

export type FightPhase = 'idle' | 'rear' | 'fire' | 'settle';

export interface DragonState {
  phase: FightPhase;
  phaseT: number;
  nextPuffAt: number;
}

export interface FightInfo {
  phase: FightPhase;
  /** 0..1 progress through the phase */
  k: number;
}

const PHASE_DUR: Record<FightPhase, number> = { idle: 1.4, rear: 0.5, fire: 0.8, settle: 0.8 };

export function updateDragon(d: DragonState, dt: number, t: number, fighting: boolean): void {
  d.phaseT += dt;
  if (!fighting) {
    d.phase = 'idle';
    return;
  }
  if (d.phaseT >= PHASE_DUR[d.phase]) {
    d.phaseT = 0;
    d.phase = d.phase === 'idle' ? 'rear' : d.phase === 'rear' ? 'fire' : d.phase === 'fire' ? 'settle' : 'idle';
  }
  void t;
}

export function fightInfo(d: DragonState): FightInfo {
  return { phase: d.phase, k: Math.min(1, d.phaseT / PHASE_DUR[d.phase]) };
}

export function isWorking(status: AgentStatus): boolean {
  return status === 'running' || status === 'thinking';
}

/** Draws the hero at (h.x, h.y) = feet centre. Returns the sprite top y (for bubbles/labels). */
export function drawHero(
  ctx: CanvasRenderingContext2D,
  h: Hero,
  t: number,
  dt: number,
  st: AmbientState,
  fight: FightInfo | null,
  selected: boolean,
): number {
  let pose: HeroPose = 'idle';
  let bob = 0;
  let dx = 0;
  let facing = h.facing;
  const working = h.arrived && !h.moving && h.status === 'running' && h.category !== null;
  const resting = h.arrived && !h.moving && (h.status === 'done' || h.status === 'idle');
  const fighting = fight !== null && h.arrived && !h.moving && isWorking(h.status);

  if (h.moving) {
    const frame = Math.floor(h.walk / 7) % 4;
    pose = frame === 0 ? 'walk1' : frame === 2 ? 'walk3' : 'idle';
    bob = frame % 2 === 1 ? -1 : 0;
  } else if (fighting && fight) {
    facing = 1;
    pose = 'raise';
    if (fight.phase === 'fire') {
      const s = Math.sin(fight.k * Math.PI);
      dx = -Math.round(s * 12);
      bob = -Math.round(s * 5);
      pose = 'idle';
    }
  } else if (resting && h.fidget) {
    const k = 1 - (h.fidgetUntil - t) / h.fidgetDur;
    if (h.fidget === 'stretch') pose = 'stretch';
    else if (h.fidget === 'sip') pose = 'sip';
    else if (h.fidget === 'hop') bob = -Math.round(Math.sin(Math.min(1, k) * Math.PI) * 3);
    else if (h.fidget === 'look') facing = k < 0.5 ? (h.facing === 1 ? -1 : 1) : h.facing;
  } else if (working) {
    pose = actionPose(h, t);
    if (h.category === 'watchtower') facing = Math.floor(t / 1.6 + h.seed) % 2 === 0 ? 1 : -1;
    if (h.category === 'arena' && (h.actionT % 1.2) / 1.2 >= 0.5) dx = 3;
  } else {
    bob = Math.sin(t * 2.4 + (h.seed % 100) / 16) > 0.55 ? -1 : 0;
  }

  const ix = Math.round(h.x - 8) + dx * facing;
  const iy = Math.round(h.y - 16) + bob;

  // shadow
  ctx.fillStyle = 'rgba(20,16,8,0.30)';
  ctx.fillRect(Math.round(h.x) - 5, Math.round(h.y) - 1, 10, 2);
  ctx.fillRect(Math.round(h.x) - 4, Math.round(h.y) + 1, 8, 1);

  // chapel glow sits under the hero
  if (working && h.category === 'chapel') {
    const pulse = 0.35 + 0.2 * Math.sin(t * 2.2);
    const grad = ctx.createRadialGradient(h.x, h.y - 8, 2, h.x, h.y - 8, 22);
    grad.addColorStop(0, `rgba(255,240,180,${pulse.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(255,240,180,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(h.x - 22, h.y - 30, 44, 44);
    if (Math.random() < dt * 3) spawn(st, { x: h.x + (Math.random() - 0.5) * 14, y: h.y - 6, vx: 0, vy: -14, age: 0, ttl: 1.6, size: 1, color: '#fff2b0', kind: 'mote' });
  }

  // selection + focus rings
  if (selected) {
    const r = 11 + Math.sin(t * 3) * 0.6;
    drawPixelRing(ctx, h.x, h.y - 1, r, 'rgba(255,255,255,0.95)');
    drawPixelRing(ctx, h.x, h.y - 1, r + 2, 'rgba(255,217,122,0.55)');
  }
  if (t < h.pulseUntil) {
    const k = (h.pulseUntil - t) / 2.2;
    const rr = 10 + (1 - ((k % 0.5) * 2)) * 12;
    drawPixelRing(ctx, h.x, h.y - 6, rr, `rgba(255,217,122,${(0.4 + k * 0.5).toFixed(3)})`);
  }

  // alchemist's pot stands in front of the hero (behind the sprite)
  if (working && h.category === 'alchemist') drawCauldron(ctx, h, t, dt, st, facing);

  // body + hand props in a facing-aware local frame
  ctx.save();
  ctx.translate(ix, iy);
  if (facing === -1) {
    ctx.translate(16, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(heroSprite(h.colorIdx, pose), 0, 0);
  if (fighting && fight) {
    ctx.drawImage(propSprite(fight.phase === 'rear' ? 'swordUp' : 'swordMid'), 12, fight.phase === 'rear' ? 0 : 3);
    if (fight.phase === 'rear' && Math.random() < dt * 8) spawn(st, { x: h.x + 6, y: h.y - 18, vx: 0, vy: -10, age: 0, ttl: 0.3, size: 1, color: '#ffffff', kind: 'sparkle' });
  } else if (working) {
    drawActionProp(ctx, h, t, dt, st, facing);
  } else if (resting && h.fidget === 'sip') {
    // mug is part of the pose
  }
  ctx.restore();

  // bubbles: category icon / thinking dots / error mark
  const top = iy;
  if (h.status === 'error') {
    const by = top - 14 - Math.round(Math.abs(Math.sin(t * 6)) * 3);
    drawBubble(ctx, h.x, by, null, '#f87171');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(h.x) - 1, by - 13, 2, 7);
    ctx.fillRect(Math.round(h.x) - 1, by - 4, 2, 2);
  } else if (fighting) {
    drawBubble(ctx, h.x, top - 12, 'arena', null);
  } else if (working && h.category) {
    drawBubble(ctx, h.x, top - 12, h.category, null);
  } else if (!h.moving && h.status === 'thinking') {
    const n = 1 + (Math.floor(t * 2.5) % 3);
    drawBubble(ctx, h.x, top - 12, null, null);
    ctx.fillStyle = '#2b2520';
    for (let i = 0; i < n; i++) ctx.fillRect(Math.round(h.x) - 5 + i * 4, top - 20, 2, 2);
  }
  return top;
}

function actionPose(h: Hero, t: number): HeroPose {
  switch (h.category) {
    case 'library':
    case 'watchtower':
    case 'alchemist':
      return 'hold';
    case 'forge':
      return (h.actionT % 0.8) / 0.8 < 0.45 ? 'raise' : 'idle';
    case 'arena':
      return (h.actionT % 1.2) / 1.2 < 0.35 ? 'raise' : 'idle';
    case 'castle':
      return 'raise';
    case 'chapel':
      return 'kneel';
    default:
      return Math.sin(t * 2.4) > 0.55 ? 'hold' : 'idle';
  }
}

/** Props in the hero's local (facing-right) frame; emits sparks/puffs on the beats. */
function drawActionProp(ctx: CanvasRenderingContext2D, h: Hero, t: number, dt: number, st: AmbientState, facing: 1 | -1): void {
  const beat = (period: number, at: number): boolean => {
    const k = (h.actionT % period) / period;
    const kPrev = ((h.actionT - dt) % period) / period;
    return kPrev < at && k >= at;
  };
  switch (h.category) {
    case 'library': {
      const flip = Math.floor(t * 1.6 + h.seed) % 2 === 0;
      ctx.drawImage(propSprite(flip ? 'bookA' : 'bookB'), 11, 8);
      break;
    }
    case 'forge': {
      const up = (h.actionT % 0.8) / 0.8 < 0.45;
      ctx.drawImage(propSprite(up ? 'hammerUp' : 'hammerDown'), up ? 12 : 12, up ? 1 : 8);
      if (beat(0.8, 0.45)) emitSparkBurst(st, { x: h.x + facing * 11, y: h.y - 5 }, '#ffd166', 6, 50);
      break;
    }
    case 'arena': {
      const k = (h.actionT % 1.2) / 1.2;
      const prop: PropId = k < 0.35 ? 'swordUp' : k < 0.5 ? 'swordMid' : 'swordDown';
      ctx.drawImage(propSprite(prop), prop === 'swordDown' ? 13 : 12, prop === 'swordUp' ? 0 : prop === 'swordMid' ? 3 : 9);
      if (beat(1.2, 0.5)) spawn(st, { x: h.x + facing * 20, y: h.y - 8, vx: facing * 40, vy: -10, age: 0, ttl: 0.25, size: 2, color: '#ffffff', kind: 'sparkle' });
      break;
    }
    case 'castle': {
      ctx.fillStyle = '#5d3d22';
      ctx.fillRect(13, -8, 1, 16);
      for (let k = 0; k < 7; k++) {
        const wave = Math.round(Math.sin(t * 6 + k * 0.9) * 1.2);
        ctx.fillStyle = k === 3 ? '#e0b040' : '#d4493f';
        ctx.fillRect(14 + k, -8 + wave, 1, 5);
      }
      break;
    }
    case 'watchtower': {
      ctx.drawImage(propSprite('spyglass'), 13, 5);
      if (Math.sin(t * 5 + h.seed) > 0.75) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(21, 5, 1, 1);
      }
      break;
    }
    case 'alchemist': {
      const a = Math.floor(h.actionT / 0.45) % 2 === 0;
      ctx.drawImage(propSprite(a ? 'ladleA' : 'ladleB'), 14, 5);
      break;
    }
    default:
      break;
  }
}

function drawCauldron(ctx: CanvasRenderingContext2D, h: Hero, t: number, dt: number, st: AmbientState, facing: 1 | -1): void {
  const px = Math.round(h.x + facing * 16);
  const py = Math.round(h.y - 2);
  drawPixelEllipse(ctx, px, py + 2, 7, 2, 'rgba(20,16,8,0.3)');
  ctx.fillStyle = '#2b2a33';
  ctx.fillRect(px - 6, py - 7, 12, 8);
  drawPixelEllipse(ctx, px, py - 7, 6, 2, '#2b2a33');
  ctx.fillStyle = '#4a4a52';
  ctx.fillRect(px - 5, py - 7, 10, 1);
  ctx.fillRect(px - 5, py + 1, 2, 2);
  ctx.fillRect(px + 3, py + 1, 2, 2);
  const hue = Math.floor((t * 50 + h.seed) % 360);
  ctx.fillStyle = `hsl(${hue} 75% 55%)`;
  ctx.fillRect(px - 4, py - 7, 8, 2);
  ctx.fillStyle = `hsl(${(hue + 40) % 360} 85% 75%)`;
  ctx.fillRect(px - 2 + Math.round(Math.sin(t * 7) * 2), py - 8, 2, 1);
  if (Math.random() < dt * 3.5) {
    spawn(st, { x: px + (Math.random() - 0.5) * 6, y: py - 9, vx: (Math.random() - 0.5) * 8, vy: -18, age: 0, ttl: 1.1, size: 2, color: `hsl(${(hue + Math.random() * 90) % 360} 80% 65%)`, kind: 'puff' });
  }
  // little fire under the pot
  ctx.fillStyle = '#ff8c3b';
  ctx.fillRect(px - 2, py + 1, 4, 2);
  ctx.fillStyle = '#ffd166';
  ctx.fillRect(px - 1, py + 1 - (Math.sin(t * 12) > 0 ? 1 : 0), 2, 2);
}

function drawBubble(ctx: CanvasRenderingContext2D, cx: number, y: number, icon: string | null, tint: string | null): void {
  const w = 18;
  const h = 16;
  const x = Math.round(cx - w / 2);
  const yy = Math.round(y - h);
  ctx.fillStyle = '#2b2520';
  ctx.fillRect(x - 1, yy - 1, w + 2, h + 2);
  ctx.fillRect(x + w / 2 - 2, yy + h + 1, 4, 1);
  ctx.fillRect(x + w / 2 - 1, yy + h + 2, 2, 1);
  ctx.fillStyle = tint ?? '#f8f3e6';
  ctx.fillRect(x, yy, w, h);
  ctx.fillRect(x + w / 2 - 1, yy + h, 2, 1);
  if (icon) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(iconSprite(icon), x + 2, yy + 1, 14, 14);
  }
}

// ── Dragon ───────────────────────────────────────────────────────────────────

export function drawDragon(ctx: CanvasRenderingContext2D, g: PlaceGeom, d: DragonState, t: number, dt: number, st: AmbientState, target: Pt | null): void {
  if (!g.dragon) return;
  const bx = g.dragon.x;
  const by = g.dragon.y;
  const breath = Math.round(Math.sin(t * 1.6));
  const rear = d.phase === 'rear' || d.phase === 'fire';
  drawPixelEllipse(ctx, bx + 36, by + 45, 44, 7, 'rgba(20,16,8,0.3)');
  // tail: segments sway with a travelling wave
  for (let i = 0; i < 7; i++) {
    const s = 7 - Math.floor(i * 0.8);
    const sx = bx + 50 + i * 8;
    const sy = by + 24 - i * 3 + Math.round(Math.sin(t * 2.2 + i * 0.7) * (0.8 + i * 0.7));
    ctx.fillStyle = '#17241a';
    ctx.fillRect(sx - 1, sy - 1, s + 2, s + 2);
    ctx.fillStyle = i % 2 === 0 ? '#4f8a4a' : '#3b6b38';
    ctx.fillRect(sx, sy, s, s);
  }
  ctx.fillStyle = '#e8dcb4';
  ctx.fillRect(bx + 106, by + 2 + Math.round(Math.sin(t * 2.2 + 4.9) * 5), 4, 4);
  // parts: outline silhouettes first, then colour
  const wing: 'wingSpread' | 'wingFolded' = rear ? 'wingSpread' : 'wingFolded';
  const flap = rear ? Math.round(Math.sin(t * 14) * 3) : 0;
  const wx = rear ? bx + 24 : bx + 30;
  const wy = rear ? by - 30 + flap : by - 18 + breath;
  let hx = bx - 18;
  let hy = by + 3 + breath;
  let open = false;
  if (d.phase === 'rear') {
    const k = Math.min(1, d.phaseT / PHASE_DUR.rear);
    hx = bx - 18 - Math.round(k * 3);
    hy = by + 3 - Math.round(k * 15);
  } else if (d.phase === 'fire') {
    hx = bx - 24;
    hy = by - 6;
    open = true;
  } else if (d.phase === 'settle') {
    const k = Math.min(1, d.phaseT / PHASE_DUR.settle);
    hx = bx - 24 + Math.round(k * 6);
    hy = by - 6 + Math.round(k * 9);
  }
  const head: 'headOpen' | 'headClosed' = open ? 'headOpen' : 'headClosed';
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    ctx.drawImage(dragonSilhouette(wing), wx + ox, wy + oy);
    ctx.drawImage(dragonSilhouette('body'), bx + ox, by + breath + oy);
    ctx.drawImage(dragonSilhouette(head), hx + ox, hy + oy);
  }
  ctx.drawImage(dragonPart(wing), wx, wy);
  ctx.drawImage(dragonPart('body'), bx, by + breath);
  ctx.drawImage(dragonPart(head), hx, hy);
  const mouth: Pt = { x: hx + 3, y: hy + 15 };
  // fire
  if (d.phase === 'fire') {
    const aim = target ?? { x: bx - 90, y: by + 60 };
    const ddx = aim.x - mouth.x;
    const ddy = aim.y - mouth.y;
    const len = Math.hypot(ddx, ddy) || 1;
    for (let i = 0; i < 6; i++) {
      const v = 120 + Math.random() * 70;
      spawn(st, {
        x: mouth.x,
        y: mouth.y,
        vx: (ddx / len) * v + (Math.random() - 0.5) * 30,
        vy: (ddy / len) * v + (Math.random() - 0.5) * 30,
        age: 0,
        ttl: 0.45 + Math.random() * 0.3,
        size: 3 + Math.random() * 3,
        color: ['#ff7a2e', '#ffd166', '#ff4d2e', '#fff1c7'][Math.floor(Math.random() * 4)] ?? '#ff7a2e',
        kind: 'flame',
      });
    }
    ctx.fillStyle = 'rgba(255,160,70,0.25)';
    ctx.fillRect(mouth.x - 20, mouth.y - 8, 26, 18);
  } else if (d.phase === 'idle' && t > d.nextPuffAt) {
    // a lazy little puff now and then
    for (let i = 0; i < 8; i++) {
      spawn(st, { x: mouth.x, y: mouth.y, vx: -30 - Math.random() * 30, vy: -8 + Math.random() * 10, age: 0, ttl: 0.4, size: 2, color: Math.random() < 0.5 ? '#ff7a2e' : '#ffd166', kind: 'flame' });
    }
    d.nextPuffAt = t + 6 + Math.random() * 5;
  }
  void dt;
}
