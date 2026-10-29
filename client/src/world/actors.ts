// Live actors: the hero (walk cycle, tavern fidgets, tool-flavoured action
// loops, status bubbles) and the perched lair dragon (a gentle hover; she is a friend, never a foe).
// Everything here draws in world coordinates.

import type { AgentState, AgentStatus, BuildingId } from '../types/agent';
import type { PlaceKind } from './registry';
import { emitSparkBurst, spawn } from './ambient';
import type { AmbientState } from './ambient';
import type { PlaceGeom } from './places';
import { drawPixelEllipse, drawPixelRing } from './pixel';
import type { Pt } from './pixel';
import { DRAGON_CELL, dragonSheetReady, drawDragonFrame } from './dragonSprite';
import { dragonPart, dragonSilhouette, heroSprite, iconSprite, propSprite } from './sprites';
import type { HeroPose, PropId } from './sprites';
import { drawLpcHero, lpcHand, lpcLookReady, preloadLook } from './lpcHero';
import { drawWeapon, weaponFor } from './weaponSprite';
import { toolToBuilding } from '../utils/spriteMapper';
import { spinnerVerb } from '../utils/spinnerVerbs';
import { FEINT_DUR, arcPoint, beatPose, createCombat, nextBeat, repositionArc } from './heroCombat';
import type { CombatState } from './heroCombat';
import type { Dir4, LpcAnim } from './lpcHero';

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
  /** LPC look index; squires all share SQUIRE_LOOK. */
  look: number;
  /** Sprite scale (1 for heroes, SQUIRE_SCALE for squires). */
  scale: number;
  isSquire: boolean;
  /** Where the current route ends: the rest slot or the work spot. */
  spot: Pt;
  /** User-dragged tavern rest spot as an offset from the plaza centre (localStorage). */
  restOffset: Pt | null;
  /** True while the pointer drags this hero around the plaza. */
  dragging: boolean;
  route: Pt[];
  routeI: number;
  roadId: string | null;
  arrived: boolean;
  walk: number;
  moving: boolean;
  facing: 1 | -1;
  /** 4-way facing of the LPC sprite, derived from the velocity by drawHero. */
  facing4?: Dir4;
  alpha: number;
  removing: boolean;
  pulseUntil: number;
  fidget: FidgetKind | null;
  fidgetUntil: number;
  fidgetDur: number;
  nextFidgetAt: number;
  actionT: number;
  pendingBurst: boolean;
  /** Dodge from a monster swing: start time and the side it hops to (set by startDodge). */
  dodgeAt?: number;
  dodgeDir?: 1 | -1;
  /** Hop distance of the current dodge; a feint is unprompted (no "miss!"). */
  dodgeDist?: number;
  dodgeFeint?: boolean;
  /** Guard pause after this dodge's landing (s). */
  dodgeGuard?: number;
  /** Offset already out of range when this dodge started (a re-dodge while walking back keeps its ground). */
  dodgeFrom?: number;
  /** When the dodged blow lands ("miss!" pops then); null for feints. */
  missAt?: number | null;
  /** A dodge scheduled from a monster's attack timeline, promoted when its start time is reached. */
  pendingDodge?: { at: number; dir: 1 | -1; src: { x: number }; dist: number; feint: boolean; guard: number; missAt: number | null };
  /** Working-state hysteresis (syncHeroStatus): last time the agent was thinking/running, the held tool category and a pending switch. */
  lastWorkAt?: number;
  workCat?: BuildingId | null;
  catPending?: BuildingId | null;
  catPendingAt?: number;
  /** "Heard you!" hop when a typed prompt is sent. */
  perkAt?: number;
  /** Moved by the Simone dragon play (dragonPlay.ts) instead of its route. */
  puppet?: boolean;
}

/** Stay in the working look this long after the agent stops thinking/running; switch action only after a category holds this long. */
const WORK_HOLD = 2.5;
const CAT_HOLD = 1.5;

/**
 * Visual status / category from the agent's raw status with hysteresis: thinking<->running flips between tool
 * calls keep the hero working at its place with its last tool's loop (or "pondering" before the first tool);
 * it only stops after WORK_HOLD s of non-working, and only changes action after CAT_HOLD s of a new category.
 */
export function syncHeroStatus(h: Hero, t: number): void {
  const a = h.agent;
  const raw = a.status;
  const prev = h.status;
  if (raw === 'thinking' || raw === 'running') {
    h.lastWorkAt = t;
    const cat = raw === 'running' ? toolToBuilding(a.tool, raw) : null;
    if (cat) {
      if (!h.workCat) {
        h.workCat = cat;
        h.catPending = null;
      } else if (cat === h.workCat) {
        h.catPending = null;
      } else if (h.catPending !== cat) {
        h.catPending = cat;
        h.catPendingAt = t;
      }
    }
    if (h.catPending && t - (h.catPendingAt ?? t) >= CAT_HOLD) {
      h.workCat = h.catPending;
      h.catPending = null;
    }
    h.status = h.workCat ? 'running' : 'thinking';
    h.category = h.workCat ?? null;
  } else if ((prev === 'running' || prev === 'thinking') && t - (h.lastWorkAt ?? -10) < WORK_HOLD) {
    // short gap between turns: keep working
  } else {
    h.workCat = null;
    h.catPending = null;
    h.status = raw;
    h.category = toolToBuilding(a.tool, raw);
  }
  if (prev !== 'done' && h.status === 'done') h.pendingBurst = true;
}

/** Spinner-verb family for the pondering loop (before the first tool of a working spell). */
type PonderKind = 'cook' | 'sketch' | 'forge' | 'think';
const COOK = /^(Bak|Brew|Caramel|Cook|Simmer|Saut|Marinat|Flamb|Frost|Julienn|Knead|Leaven|Ferment|Garnish|Blanch|Drizzl|Infus|Concoct|Stew|Whisk|Churn)/;
function ponderKind(seed: number): PonderKind {
  const v = spinnerVerb(seed);
  if (COOK.test(v)) return 'cook';
  if (/^(Sketch|Doodl)/.test(v)) return 'sketch';
  if (/^(Forg|Temper)/.test(v)) return 'forge';
  return 'think';
}

/** Chat-style "…" bubble (three bouncing dots) with its tail at (x, y), world px. */
export function drawTypingBubble(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const w = 15;
  const h = 8;
  const bx = Math.round(x - 3);
  const by = Math.round(y - h - 2);
  ctx.fillStyle = '#2b2520';
  ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
  ctx.fillRect(bx, by + h + 1, 2, 2);
  ctx.fillStyle = '#f8f3e6';
  ctx.fillRect(bx, by, w, h);
  ctx.fillRect(bx + 1, by + h, 1, 1);
  ctx.fillStyle = '#5d4524';
  for (let i = 0; i < 3; i++) {
    const hop = Math.sin(t * 9 - i * 0.9) > 0.35 ? 1 : 0;
    ctx.fillRect(bx + 3 + i * 4, by + 3 - hop, 2, 2);
  }
}

/** The perched dragon's hover clock and last flight frame (for one-shot wing dust). */
export interface DragonState {
  flapT: number;
  lastFrame: number;
}

export function isWorking(status: AgentStatus): boolean {
  return status === 'running' || status === 'thinking';
}

/** Per-hero animation memory kept between frames: one-shot timers + the last position (for the facing). */
interface AnimMem {
  status: AgentStatus;
  statusAt: number;
  px: number;
  py: number;
  standing: boolean;
  flourishUntil: number;
  lastFrame: number;
  /** Dodge start / landing already given their dust puffs. */
  dodgeFx: number;
  dodgeLandFx: number;
  /** Last weapon pose drawn (held when a frame has no hand entry). */
  lastPose: { x: number; y: number; angle: number } | null;
  /** Seeded combat beats while fighting a foe / drilling. */
  combat: CombatState;
}

const animMem = new WeakMap<Hero, AnimMem>();
const HURT_DUR = 0.9;
const FLOURISH_DUR = 0.95;

/** Tracks status changes / arrivals for the one-shot animations and derives `facing4` from the velocity. */
function heroAnimMem(h: Hero, t: number): AnimMem {
  let m = animMem.get(h);
  if (!m) {
    m = { status: h.status, statusAt: t, px: h.x, py: h.y, standing: false, flourishUntil: 0, lastFrame: -1, dodgeFx: -1, dodgeLandFx: -1, lastPose: null, combat: createCombat() };
    animMem.set(h, m);
    preloadLook(h.look, h.scale);
  }
  const standing = h.arrived && !h.moving;
  if (h.status !== m.status) {
    m.status = h.status;
    m.statusAt = t;
    if (h.status === 'done' && standing) m.flourishUntil = t + FLOURISH_DUR;
  }
  if (standing && !m.standing && h.status === 'done') m.flourishUntil = t + FLOURISH_DUR;
  m.standing = standing;
  const dx = h.x - m.px;
  const dy = h.y - m.py;
  m.px = h.x;
  m.py = h.y;
  if (h.moving && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)) {
    // the current axis wins near-ties so diagonal roads don't flicker
    const horiz = h.facing4 === 'left' || h.facing4 === 'right';
    if (Math.abs(dx) > Math.abs(dy) * (horiz ? 0.8 : 1.25)) h.facing4 = dx < 0 ? 'left' : 'right';
    else h.facing4 = dy < 0 ? 'up' : 'down';
  }
  return m;
}

/** Something the hero squares up to and swings at (a monster's chest point; `fy` its feet). */
export interface Foe {
  x: number;
  y: number;
  fy?: number;
}

export interface HeroDrawOpts {
  selected: boolean;
  /** Unresolved error / war target: face it and run the attack loop. */
  foe: Foe | null;
  /** War formation: sword drills with nobody to hit. */
  drill: boolean;
  /** Called on the strike frame of an attack at `foe` (hit flash + knock-back on the monster). */
  onStrike?: () => void;
  /** Petting the Simone dragon lying beside it. */
  pet?: { faceRight: boolean } | null;
  /** Open ground test (world/terrain isWalkable) for repositions and feint hops. */
  walkable?: (x: number, y: number) => boolean;
}

/**
 * Dodge (and feint): a slow hop out on a high arc, a beat held at the far point, a guarded stance at that
 * distance (weapon raised, breathing, no attacks), then a walk back into range before the next beat.
 */
const DODGE_OUT = 0.38;
const DODGE_APEX = 0.12;
const DODGE_GUARD_MIN = 0.8;
const DODGE_GUARD_RANGE = 0.4;
const DODGE_BACK = 0.35;
const DODGE_HOP = 8;
const DODGE_DIST = 22;
const FEINT_DIST = 14;
const GUARD_REL = -60;

/** Full length of the hero's current dodge (the guard pause is rolled per dodge). */
function dodgeTotal(h: Hero): number {
  return DODGE_OUT + DODGE_APEX + (h.dodgeGuard ?? DODGE_GUARD_MIN) + DODGE_BACK;
}
/** "miss!" pop above a dodging hero (s). */
const MISS_DUR = 0.7;
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A monster at `fromX` swings at this hero: hop away `delay` s from now (never while dragged or mid-dodge). */
export function startDodge(h: Hero, from: { x: number }, t: number, delay = 0, feint = false, missAt: number | null = null, dist: number | null = null): void {
  if (h.dragging || h.removing) return;
  const at = t + delay;
  // still hopping out / at the far point when this one would start: already clear of the blow
  const cur = dodgeT(h, at);
  if (cur !== null && cur < DODGE_OUT + DODGE_APEX) return;
  if (h.pendingDodge && h.pendingDodge.at <= at + 0.05) return;
  h.pendingDodge = {
    at,
    dir: h.x < from.x ? -1 : 1,
    src: from,
    dist: dist ?? (feint ? FEINT_DIST : DODGE_DIST),
    feint,
    guard: DODGE_GUARD_MIN + Math.random() * DODGE_GUARD_RANGE,
    missAt,
  };
}

/** Offset (px, away from the foe) `s` seconds into the current dodge. */
function dodgeOffset(h: Hero, s: number): number {
  const dist = h.dodgeDist ?? DODGE_DIST;
  const from = Math.min(dist, h.dodgeFrom ?? 0);
  const tBack = DODGE_OUT + DODGE_APEX + (h.dodgeGuard ?? DODGE_GUARD_MIN);
  if (s < DODGE_OUT) {
    const k = s / DODGE_OUT;
    return from + (dist - from) * (1 - (1 - k) * (1 - k));
  }
  if (s < tBack) return dist;
  const k = Math.min(1, (s - tBack) / DODGE_BACK);
  return dist * (1 - k * k * (3 - 2 * k));
}

/** Sideways offset the dodge is drawing the hero at right now (shadow, "miss!" and body move together). */
function dodgeVisualDx(h: Hero, t: number): number {
  if (reducedMotion || h.moving) return 0;
  const ds = dodgeT(h, t);
  return ds === null ? 0 : Math.round((h.dodgeDir ?? 1) * dodgeOffset(h, ds));
}

/** Starts a scheduled dodge once its time comes (timestamp-driven, robust to dropped frames). */
function promoteDodge(h: Hero, t: number): void {
  const p = h.pendingDodge;
  if (!p || t < p.at) return;
  const prev = h.dodgeAt !== undefined && !h.dragging ? p.at - h.dodgeAt : -1;
  const active = prev >= 0 && prev < dodgeTotal(h) && (h.dodgeDir ?? 1) === (h.x < p.src.x ? -1 : 1);
  h.dodgeFrom = active ? dodgeOffset(h, prev) : 0;
  // away from where the foe is NOW (it may have prowled since the dodge was scheduled)
  const dir: 1 | -1 = h.x === p.src.x ? p.dir : h.x < p.src.x ? -1 : 1;
  h.dodgeAt = p.at;
  h.dodgeDir = dir;
  h.dodgeDist = p.dist;
  h.dodgeFeint = p.feint;
  h.dodgeGuard = p.guard;
  h.missAt = p.missAt;
  h.pendingDodge = undefined;
}

/** True while a dodge is queued or playing (the combat beats hold still). */
function dodgeBusy(h: Hero, t: number): boolean {
  if (h.dragging) return false;
  return h.pendingDodge !== undefined || (h.dodgeAt !== undefined && t < h.dodgeAt + dodgeTotal(h));
}

/** Seconds into the current dodge, or null when not dodging. */
function dodgeT(h: Hero, t: number): number | null {
  if (h.dodgeAt === undefined || h.dragging) return null;
  const s = t - h.dodgeAt;
  return s >= 0 && s < dodgeTotal(h) ? s : null;
}

/** Facing angle (deg) of a 4-way direction. */
function facingAngle(dir: Dir4): number {
  return dir === 'right' ? 0 : dir === 'left' ? 180 : dir === 'down' ? 90 : -90;
}

/** Relative swing angle → screen angle, mirrored for left (and turned for up / down). */
function swingAngle(rel: number, dir: Dir4): number {
  if (dir === 'left') return 180 - rel;
  if (dir === 'down') return 60 + rel;
  if (dir === 'up') return -120 - rel;
  return rel;
}

/** Draws the hero at (h.x, h.y) = feet centre. Returns the sprite top y (for bubbles/labels). */
export function drawHero(ctx: CanvasRenderingContext2D, h: Hero, t: number, dt: number, st: AmbientState, opts: HeroDrawOpts): number {
  const { selected } = opts;
  const standing = h.arrived && !h.moving;
  const pet = standing ? (opts.pet ?? null) : null;
  const attacking = standing && !pet && (opts.foe !== null || opts.drill);
  const working = standing && !pet && !attacking && h.status === 'running' && h.category !== null;
  // thinking before any tool this spell: a pondering loop themed by the spinner verb
  const ponder: PonderKind | null = standing && !pet && !attacking && h.status === 'thinking' ? ponderKind(h.seed) : null;
  const resting = standing && !attacking && (h.status === 'done' || h.status === 'idle');
  const m = heroAnimMem(h, t);
  promoteDodge(h, t);
  const look = h.look;
  const lpc = lpcLookReady(look, h.scale);

  // shadow (follows the body through a dodge hop)
  if (lpc) {
    drawPixelEllipse(ctx, Math.round(h.x) + dodgeVisualDx(h, t), Math.round(h.y), Math.round(7 * h.scale), 2, 'rgba(20,16,8,0.30)');
  } else {
    ctx.fillStyle = 'rgba(20,16,8,0.30)';
    ctx.fillRect(Math.round(h.x) - 5, Math.round(h.y) - 1, 10, 2);
    ctx.fillRect(Math.round(h.x) - 4, Math.round(h.y) + 1, 8, 1);
  }

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

  // alchemist's pot / smith's anvil stand beside the hero (behind the sprite)
  if ((working && h.category === 'alchemist') || ponder === 'cook') drawCauldron(ctx, h, t, dt, st, h.facing);
  if (((working && h.category === 'forge') || ponder === 'forge') && lpc) drawAnvil(ctx, Math.round(h.x + ANVIL_DX * h.scale), Math.round(h.y + 1));

  // body: LPC sheet when composited, the pixel hero until then
  const top = (lpc ? drawLpcBody(ctx, h, m, look, t, dt, st, opts, working, resting, attacking, ponder) : null) ?? drawPixelBody(ctx, h, t, dt, st, opts, working, resting, attacking);
  drawMissPop(ctx, h, top, t);

  // spellcast glow at the hands on the casting frames (chapel / alchemist / castle)
  if (working && lpc && (h.category === 'chapel' || h.category === 'alchemist' || h.category === 'castle')) {
    const f = Math.floor(h.actionT * 7) % 7;
    if (f >= 3) {
      const k = (f - 2) / 4;
      const color = h.category === 'chapel' ? '255,240,180' : h.category === 'alchemist' ? '150,255,200' : '216,200,255';
      const hx = h.x;
      const hy = top + 9;
      const grad = ctx.createRadialGradient(hx, hy, 1, hx, hy, 9 + k * 5);
      grad.addColorStop(0, `rgba(${color},${(0.55 * k).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(hx - 16, hy - 16, 32, 32);
      if (Math.random() < dt * 6) spawn(st, { x: hx + (Math.random() - 0.5) * 10, y: hy, vx: (Math.random() - 0.5) * 6, vy: -16, age: 0, ttl: 0.8, size: 1, color: `rgb(${color})`, kind: 'mote' });
    }
  }

  // bubbles: category icon / thinking dots / error mark
  if (h.status === 'error') {
    const by = top - 14 - Math.round(Math.abs(Math.sin(t * 6)) * 3);
    drawBubble(ctx, h.x, by, null, '#f87171');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(h.x) - 1, by - 13, 2, 7);
    ctx.fillRect(Math.round(h.x) - 1, by - 4, 2, 2);
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

/** The anvil stands this far to the hero's right while forging. */
const ANVIL_DX = 13;

/**
 * LPC body: picks the animation, 4-way facing and frame from the hero's state
 * (walk / per-category action loops / attack at a foe / one-shot hurt + done
 * flourish / tavern fidgets). Returns the sprite top, or null when the sheet
 * is not ready.
 */
function drawLpcBody(
  ctx: CanvasRenderingContext2D,
  h: Hero,
  m: AnimMem,
  look: number,
  t: number,
  dt: number,
  st: AmbientState,
  opts: HeroDrawOpts,
  working: boolean,
  resting: boolean,
  attacking: boolean,
  ponder: PonderKind | null,
): number | null {
  let anim: LpcAnim = 'walk';
  let frame = 0;
  // arrived heroes face the viewer; a mid-road stop keeps the walking direction
  let dir: Dir4 = h.arrived ? 'down' : (h.facing4 ?? 'down');
  let bob = 0;
  let dx = 0;
  // swing progress through the slash cycle (constrained arc) / thrust cycle (no rotation)
  let bladeRel: number | null = null;
  let thrustPush: number | null = null;
  let smear = 0;
  if (h.moving) {
    dir = h.facing4 ?? 'down';
    // 58 px/s over 6.5 px per frame ≈ 9 fps; frame 0 is the standing pose
    frame = 1 + (Math.floor(h.walk / 6.5) % 8);
  } else if (opts.pet && h.arrived) {
    // petting the dragon's head: facing her, hand out and stroking (thrust frames reach forward at head height)
    dir = opts.pet.faceRight ? 'right' : 'left';
    anim = 'thrust';
    frame = Math.floor(t * 2.6) % 2 === 0 ? 2 : 3;
    bob = Math.sin(t * 2.6) > 0.6 ? -1 : 0;
  } else if (h.status === 'error' && t - m.statusAt < HURT_DUR) {
    anim = 'hurt';
    frame = Math.min(5, Math.floor(((t - m.statusAt) / HURT_DUR) * 6));
  } else if (attacking) {
    // choreographed beats (heroCombat.ts): slash / double / thrust / guard stance / feint hop / reposition around the foe
    const foe = opts.foe;
    const cs = m.combat;
    const canMove = foe !== null && foe.fy !== undefined && !h.dragging;
    const busy = dodgeBusy(h, t);
    // out of range / recovering from a dodge: no beat runs; the first one back in range is an attack
    if (busy && dodgeT(h, t) !== null) cs.afterDodge = true;
    let b = cs.beat;
    if (!busy && (!b || t >= b.start + b.dur || cs.afterDodge)) {
      b = nextBeat(cs, h.seed, t, canMove, cs.afterDodge);
      cs.afterDodge = false;
      if (b.kind === 'feint' && !foe) {
        b.kind = 'stance';
        b.dur = 0.6;
      } else if (b.kind === 'feint' && foe && opts.walkable && !opts.walkable(h.x + (h.x < foe.x ? -1 : 1) * 14, h.y)) {
        // no room behind (pond / trunk): guard instead
        b.kind = 'stance';
        b.dur = 0.6;
      } else if (b.kind === 'feint' && foe) {
        // unprompted short hop back from the foe, a guarded pause, then back in
        startDodge(h, foe, t, 0, true);
        b.dur = FEINT_DUR;
      } else if (b.kind === 'reposition' && foe && foe.fy !== undefined) {
        // walk the arc only if it ends (and passes) on open ground; else the other way round, else guard
        const ok = (arc: ReturnType<typeof repositionArc>): boolean => !!arc && (!opts.walkable || [0.5, 1].every((k) => { const q = arcPoint(arc, k); return opts.walkable?.(q.x, q.y) ?? true; }));
        let arc = repositionArc(h.x, h.y, foe.x, foe.fy, b.sign);
        if (!ok(arc)) arc = repositionArc(h.x, h.y, foe.x, foe.fy, b.sign === 1 ? -1 : 1);
        if (ok(arc)) b.arc = arc;
        else {
          b.kind = 'stance';
          b.dur = 0.6;
        }
      }
    }
    if (!b) b = nextBeat(cs, h.seed, t, canMove);
    const s = t - b.start;
    if (b.kind === 'reposition' && b.arc && !h.dragging && !busy) {
      const pt = arcPoint(b.arc, Math.min(1, s / b.dur));
      h.x = pt.x;
      h.y = pt.y;
    }
    const right = foe ? foe.x >= h.x : b.sign === 1;
    dir = right ? 'right' : 'left';
    const pose = beatPose(b, s, t);
    anim = pose.anim;
    frame = pose.frame;
    dx = pose.dx;
    bob = pose.bob;
    bladeRel = pose.bladeRel;
    thrustPush = pose.thrustPush;
    smear = pose.smear;
    // lean into the blow on the strike / follow-through frames
    if ((anim === 'slash' && (frame === 4 || frame === 5)) || (anim === 'thrust' && (frame === 4 || frame === 5))) dx += (right ? 1 : -1) * 2;
    if (pose.impacts > b.hits) {
      b.hits = pose.impacts;
      // a blow swung mid-dodge never lands
      const clear = dodgeT(h, t) === null;
      if (clear && foe) {
        emitSparkBurst(st, { x: foe.x, y: foe.y }, '#ffffff', 4, 45);
        opts.onStrike?.();
      } else if (clear) spawn(st, { x: h.x + (right ? 14 : -14), y: h.y - 2, vx: 0, vy: -6, age: 0, ttl: 0.3, size: 2, color: '#c8b89a', kind: 'puff' });
    }
  } else if (resting && h.fidget) {
    const k = 1 - (h.fidgetUntil - t) / h.fidgetDur;
    if (h.fidget === 'stretch') {
      anim = 'spellcast';
      frame = k < 0.25 ? 1 : 2;
    } else if (h.fidget === 'sip') {
      anim = 'thrust';
      frame = 1;
    } else if (h.fidget === 'hop') {
      bob = -Math.round(Math.sin(Math.min(1, k) * Math.PI) * 3);
    } else if (h.fidget === 'look' && k < 0.5) {
      dir = h.facing === 1 ? 'right' : 'left';
    }
  } else if (resting && t < m.flourishUntil) {
    anim = 'spellcast';
    frame = Math.floor((1 - (m.flourishUntil - t) / FLOURISH_DUR) * 7);
    dir = 'down';
  } else if (ponder) {
    // pondering (no tool yet this spell), always moving on its own clock so status flips never freeze it
    dir = 'down';
    if (ponder === 'cook') {
      anim = 'spellcast';
      frame = Math.floor(t * 3) % 2 === 0 ? 2 : 3;
    } else if (ponder === 'forge') {
      dir = 'right';
      anim = 'slash';
      frame = Math.floor(t * 8) % 6;
      bob = frame === 3 || frame === 4 ? 3 : frame === 2 ? 1 : 0;
      if (frame === 3 && m.lastFrame !== 3) emitSparkBurst(st, { x: h.x + ANVIL_DX * h.scale, y: h.y - 7 }, '#ffd166', 5, 50);
    } else if (ponder === 'sketch') {
      anim = 'spellcast';
      frame = 2;
      bob = Math.floor(t * 4) % 2 === 0 ? 0 : -1;
    } else {
      // hand to the chin, a slow sway, "…" motes drifting up
      anim = 'spellcast';
      frame = Math.sin(t * 1.3 + (h.seed % 7)) > 0.6 ? 2 : 1;
      bob = Math.sin(t * 2.2) > 0.7 ? -1 : 0;
      if (Math.random() < dt * 2.5) spawn(st, { x: h.x + 5 + Math.random() * 4, y: h.y - 26 * h.scale, vx: 2, vy: -8, age: 0, ttl: 0.9, size: 1, color: '#f4ead2', kind: 'mote' });
    }
  } else if (working) {
    dir = 'down';
    switch (h.category) {
      case 'forge': {
        // crouched hammering at the anvil: sink on the strike frames, sparks off the horn
        dir = 'right';
        anim = 'slash';
        frame = Math.floor(h.actionT * 8) % 6;
        bob = frame === 3 || frame === 4 ? 3 : frame === 2 ? 1 : 0;
        if (frame === 3 && m.lastFrame !== 3) emitSparkBurst(st, { x: h.x + ANVIL_DX * h.scale, y: h.y - 7 }, '#ffd166', 7, 55);
        break;
      }
      case 'library': {
        // reading: hands together at the chest (spellcast 2) hold the book; a page flicks open every 1.8 s
        anim = 'spellcast';
        const k = h.actionT % 1.8;
        frame = k < 0.14 ? 3 : 2;
        if (k < 0.14 && m.lastFrame === 2) spawn(st, { x: h.x + 3, y: h.y - 13, vx: 12, vy: -10, age: 0, ttl: 0.35, size: 1, color: '#f4ead2', kind: 'sparkle' });
        break;
      }
      case 'arena': {
        // thrust drills: lunge on the strike with a puff of dust at the feet
        anim = 'thrust';
        frame = 4 + (Math.floor(h.actionT * 8) % 4);
        bob = frame === 6 || frame === 7 ? 2 : 0;
        if (frame === 6 && m.lastFrame !== 6) {
          for (let i = 0; i < 3; i++) spawn(st, { x: h.x + (Math.random() - 0.5) * 8, y: h.y + 1, vx: (Math.random() - 0.5) * 24, vy: -6 - Math.random() * 6, age: 0, ttl: 0.35, size: 2, color: '#c8b89a', kind: 'puff' });
        }
        break;
      }
      case 'watchtower':
        anim = 'shoot';
        frame = 4 + (Math.floor(h.actionT * 8) % 9);
        dir = Math.floor(t / 1.6 + h.seed) % 2 === 0 ? 'right' : 'left';
        break;
      default:
        anim = 'spellcast';
        frame = Math.floor(h.actionT * 7) % 7;
    }
  } else {
    bob = Math.sin(t * 2.4 + (h.seed % 100) / 16) > 0.55 ? -1 : 0;
  }
  // "heard you!" perk-up when a typed prompt is sent
  if (h.perkAt !== undefined && t - h.perkAt < 0.32) bob -= Math.round(Math.sin(((t - h.perkAt) / 0.32) * Math.PI) * 4);
  // sword in hand: walking, standing about, fighting, drilling and the done flourish (not at work stations or mid-fidget)
  const armed = !opts.pet && (h.moving || attacking || anim === 'walk' || (anim === 'spellcast' && resting && t < m.flourishUntil) || (working && h.category === 'arena'));
  m.lastFrame = frame;
  // a new fight starts with a fresh (seeded) guard
  if (!attacking) m.combat.beat = null;
  // dodge: hop ~22 px away from the swing on a small arc (lean + squash on landing), then step back in
  let lean = 0;
  let sqx = 1;
  let sqy = 1;
  const ds = dodgeT(h, t);
  if (ds !== null && !h.moving) {
    const away = h.dodgeDir ?? 1;
    const puff = (n: number, size: number, vx0: number): void => {
      for (let i = 0; i < n; i++) spawn(st, { x: h.x + dx + (Math.random() - 0.5) * 10, y: h.y + 1, vx: vx0 + (Math.random() - 0.5) * 30, vy: -4 - Math.random() * 8, age: 0, ttl: 0.45 + Math.random() * 0.2, size, color: '#c8b89a', kind: 'puff' });
    };
    if (m.dodgeFx !== h.dodgeAt) {
      m.dodgeFx = h.dodgeAt ?? -1;
      puff(8, 3, -away * 14);
    }
    const dist = h.dodgeDist ?? DODGE_DIST;
    const guard = h.dodgeGuard ?? DODGE_GUARD_MIN;
    const tLand = DODGE_OUT + DODGE_APEX;
    const tBack = tLand + guard;
    dir = away === 1 ? 'left' : 'right'; // keep facing the monster
    bladeRel = null;
    thrustPush = null;
    smear = 0;
    if (reducedMotion) {
      drawPixelRing(ctx, h.x, h.y - 10 * h.scale, 9 * h.scale, `rgba(255,255,255,${(0.9 * Math.max(0, 1 - ds / 0.5)).toFixed(3)})`);
      anim = 'slash';
      frame = 0;
      bladeRel = GUARD_REL;
    } else {
      const off = dodgeOffset(h, ds);
      if (ds < DODGE_OUT) {
        // slow hop out on a high arc (lower when it starts already part-way out)
        const k = ds / DODGE_OUT;
        bob = -Math.round(Math.sin(k * Math.PI) * DODGE_HOP * (1 - Math.min(1, (h.dodgeFrom ?? 0) / dist)));
        lean = away * Math.sin(k * Math.PI) * 0.18;
        anim = 'walk';
        frame = 3;
      } else if (ds < tBack) {
        // landed: a beat at the far point, then a guarded stance there (weapon up, breathing, no attacks)
        if (ds - DODGE_OUT < 0.1) {
          sqx = 1.08;
          sqy = 0.9;
        }
        if (m.dodgeLandFx !== h.dodgeAt) {
          m.dodgeLandFx = h.dodgeAt ?? -1;
          puff(6, 3, away * 10);
        }
        anim = ds < tLand ? 'walk' : 'slash';
        frame = 0;
        if (ds >= tLand) {
          bladeRel = GUARD_REL;
          bob = Math.sin((ds - tLand) * 5.5) > 0.3 ? -1 : 0;
        }
      } else {
        // walk back into range
        const k = Math.min(1, (ds - tBack) / DODGE_BACK);
        anim = 'walk';
        frame = 1 + (Math.floor(k * 8) % 8);
      }
      dx += Math.round(away * off);
    }
  }
  const bx = h.x + dx;
  const by = h.y + bob;
  // weapon pose: hilt at the measured hand; slash = constrained arc, thrust = fixed at the facing and pushed forward
  const hand = armed ? lpcHand(anim, dir, frame, bx, by, h.scale) : null;
  let pose = hand;
  if (hand && bladeRel !== null) {
    pose = { x: hand.x, y: hand.y, angle: swingAngle(bladeRel, dir) };
  } else if (thrustPush !== null) {
    const base = lpcHand('thrust', dir, 1, bx, by, h.scale);
    const fa = (facingAngle(dir) * Math.PI) / 180;
    if (base) pose = { x: base.x + Math.cos(fa) * thrustPush, y: base.y + Math.sin(fa) * thrustPush, angle: facingAngle(dir) };
  }
  // no hand entry for this frame: hold the last blade angle at the previous grip instead of snapping
  if (!pose && armed && m.lastPose) pose = m.lastPose;
  m.lastPose = pose;
  const weapon = weaponFor(h.seed, h.isSquire);
  const xf = lean !== 0 || sqx !== 1;
  if (xf) {
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(lean);
    ctx.scale(sqx, sqy);
    ctx.translate(-bx, -by);
  }
  const drawBlade = (): void => {
    if (!pose) return;
    // impact: a faint arc trails the blade for ~2-3 frames instead of spinning it
    if (smear > 0 && bladeRel !== null) {
      const a = smear;
      const ang = (pose.angle * Math.PI) / 180;
      const trail = (70 * Math.PI) / 180;
      const ccw = dir === 'left';
      const r = 14 * h.scale;
      ctx.lineWidth = 1.5;
      for (const [rr, al] of [[r, 0.5], [r * 0.7, 0.28]] as const) {
        ctx.strokeStyle = `rgba(255,255,255,${(al * a).toFixed(3)})`;
        ctx.beginPath();
        if (ccw) ctx.arc(pose.x, pose.y, rr, ang, ang + trail);
        else ctx.arc(pose.x, pose.y, rr, ang - trail, ang);
        ctx.stroke();
      }
    }
    drawWeapon(ctx, weapon, pose.x, pose.y, pose.angle, h.scale);
  };
  // facing away, the blade is behind the body
  if (dir === 'up') drawBlade();
  const top = drawLpcHero(ctx, look, anim, dir, frame, bx, by, h.scale);
  if (dir !== 'up' && top !== null) drawBlade();
  if (xf) ctx.restore();
  if (ponder === 'sketch' && top !== null) drawSketchScroll(ctx, bx, by, t, h.scale);
  return top;
}

/** A small scroll held at the chest with a doodle that draws itself and starts over. */
function drawSketchScroll(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, scale: number): void {
  const sx = Math.round(x - 5 * scale);
  const sy = Math.round(y - 13 * scale);
  ctx.fillStyle = '#5d4524';
  ctx.fillRect(sx - 1, sy - 1, 12, 8);
  ctx.fillStyle = '#f4ead2';
  ctx.fillRect(sx, sy, 10, 6);
  const n = Math.floor((t * 6) % 12);
  ctx.fillStyle = '#2b2520';
  for (let i = 0; i < Math.min(n, 8); i++) ctx.fillRect(sx + 1 + i, sy + 2 + (Math.sin(i * 1.7) > 0 ? 0 : 2), 1, 1);
  // quill tip
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(sx + 1 + Math.min(n, 8), sy + 1, 1, 2);
}

/** "miss!" rising and fading over a hero that just dodged. */
function drawMissPop(ctx: CanvasRenderingContext2D, h: Hero, top: number, t: number): void {
  // pops when the dodged blow lands (whiffing into the space the hero just left)
  if (h.missAt === undefined || h.missAt === null || h.dodgeFeint) return;
  const s = t - h.missAt;
  if (s < 0 || s > MISS_DUR) return;
  const k = s / MISS_DUR;
  // floats up beside the hero on the monster's side (where the blow whiffed), clear of the name, bubble and caption above the head
  const toward = -(h.dodgeDir ?? 1);
  const x = Math.round(h.x + dodgeVisualDx(h, t) + toward * 12 * h.scale);
  const y = Math.round(top + 10 * h.scale - (reducedMotion ? 0 : k * 7));
  ctx.save();
  ctx.globalAlpha *= k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = toward === 1 ? 'left' : 'right';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1a1410';
  ctx.strokeText('miss!', x, y);
  ctx.fillStyle = '#fff1a8';
  ctx.fillText('miss!', x, y);
  ctx.restore();
}

/** Programmatic 16 px hero (pre-LPC art; also the fallback while sheets load). Returns the sprite top. */
function drawPixelBody(
  ctx: CanvasRenderingContext2D,
  h: Hero,
  t: number,
  dt: number,
  st: AmbientState,
  opts: HeroDrawOpts,
  working: boolean,
  resting: boolean,
  attacking: boolean,
): number {
  let pose: HeroPose = 'idle';
  let bob = 0;
  let dx = 0;
  let facing = h.facing;
  if (h.moving) {
    const frame = Math.floor(h.walk / 7) % 4;
    pose = frame === 0 ? 'walk1' : frame === 2 ? 'walk3' : 'idle';
    bob = frame % 2 === 1 ? -1 : 0;
  } else if (attacking) {
    const foe = opts.foe;
    facing = foe ? (foe.x >= h.x ? 1 : -1) : Math.floor(t / 2.2 + h.seed) % 2 === 0 ? 1 : -1;
    pose = (t * 3) % 1 < 0.4 ? 'raise' : 'idle';
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
  const ix = Math.round(h.x - 8 * h.scale) + dx * facing;
  const iy = Math.round(h.y - 16 * h.scale) + bob;
  // body + hand props in a facing-aware local frame
  ctx.save();
  ctx.translate(ix, iy);
  ctx.scale(h.scale, h.scale);
  if (facing === -1) {
    ctx.translate(16, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(heroSprite(h.colorIdx, pose), 0, 0);
  if (attacking) {
    ctx.drawImage(propSprite(pose === 'raise' ? 'swordUp' : 'swordMid'), 12, pose === 'raise' ? 0 : 3);
  } else if (working) {
    drawActionProp(ctx, h, t, dt, st, facing);
  }
  ctx.restore();
  return iy;
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

/** Smith's anvil on a stump; (x, y) is the base centre. */
function drawAnvil(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  drawPixelEllipse(ctx, x, y + 1, 7, 2, 'rgba(20,16,8,0.3)');
  ctx.fillStyle = '#5d3d22';
  ctx.fillRect(x - 3, y - 5, 6, 5);
  ctx.fillStyle = '#8a5a33';
  ctx.fillRect(x - 3, y - 5, 2, 5);
  ctx.fillStyle = '#2b2a33';
  ctx.fillRect(x - 4, y - 7, 8, 2);
  ctx.fillRect(x - 7, y - 10, 14, 3);
  ctx.fillRect(x + 7, y - 9, 2, 1);
  ctx.fillStyle = '#6e7682';
  ctx.fillRect(x - 7, y - 10, 14, 1);
  ctx.fillStyle = '#9aa1ad';
  ctx.fillRect(x - 6, y - 10, 5, 1);
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

/** Sheet scale: 205x161 cells → ~116 px wingspan on the perch. */
const DRAGON_SHEET_SCALE = 0.75;

/**
 * The lair dragon on her perch: a gentle hover on the flight loop with wing dust off the ledge.
 * She is a friend, never a foe (no fire, no fight). Falls back to the vector dragon until the sheet loads.
 */
export function drawDragon(ctx: CanvasRenderingContext2D, g: PlaceGeom, d: DragonState, t: number, dt: number, st: AmbientState): void {
  if (!g.dragon) return;
  if (!dragonSheetReady()) {
    drawVectorDragon(ctx, g, t);
    return;
  }
  // perch centre (matches the ledge painted in places.ts)
  const perch: Pt = { x: g.dragon.x + 36, y: g.dragon.y + 48 };
  d.flapT += dt;
  const bob = Math.sin(t * 2.4) * 3;
  const cellW = Math.round(DRAGON_CELL.w * DRAGON_SHEET_SCALE);
  // sits a little left of the ledge centre so the head overhangs toward the caves
  const x = perch.x - 16 - cellW / 2;
  const y = perch.y - 95 - bob; // claws rest on the ledge; the bob lifts her
  const up = bob + 6;
  drawPixelEllipse(ctx, perch.x, perch.y + 2, Math.max(18, Math.round(46 - up * 1.2)), 6, `rgba(20,16,8,${(0.32 - up * 0.008).toFixed(3)})`);
  const index = drawDragonFrame(ctx, d.flapT, x, y, DRAGON_SHEET_SCALE);
  if (index === null) return;
  // wing-beat dust off the ledge on the down-stroke (flight frame 4)
  if (index === 4 && d.lastFrame !== 4 && Math.random() < 0.35) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        spawn(st, { x: perch.x + side * (26 + Math.random() * 22), y: perch.y + 2, vx: side * (14 + Math.random() * 18), vy: -3 - Math.random() * 4, age: 0, ttl: 0.6, size: 2, color: '#9a9ea6', kind: 'puff' });
      }
    }
  }
  d.lastFrame = index;
}

/** Programmatic dragon (pre-sprite-sheet) — drawn only while the sheet is unavailable. */
function drawVectorDragon(ctx: CanvasRenderingContext2D, g: PlaceGeom, t: number): void {
  if (!g.dragon) return;
  const bx = g.dragon.x;
  const by = g.dragon.y;
  const breath = Math.round(Math.sin(t * 1.6));
  drawPixelEllipse(ctx, bx + 36, by + 45, 44, 7, 'rgba(20,16,8,0.3)');
  // tail: segments sway with a travelling wave
  for (let i = 0; i < 7; i++) {
    const sz = 7 - Math.floor(i * 0.8);
    const sx = bx + 50 + i * 8;
    const sy = by + 24 - i * 3 + Math.round(Math.sin(t * 2.2 + i * 0.7) * (0.8 + i * 0.7));
    ctx.fillStyle = '#17241a';
    ctx.fillRect(sx - 1, sy - 1, sz + 2, sz + 2);
    ctx.fillStyle = i % 2 === 0 ? '#4f8a4a' : '#3b6b38';
    ctx.fillRect(sx, sy, sz, sz);
  }
  ctx.fillStyle = '#e8dcb4';
  ctx.fillRect(bx + 106, by + 2 + Math.round(Math.sin(t * 2.2 + 4.9) * 5), 4, 4);
  // parts: outline silhouettes first, then colour
  const wx = bx + 30;
  const wy = by - 18 + breath;
  const hx = bx - 18;
  const hy = by + 3 + breath;
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    ctx.drawImage(dragonSilhouette('wingFolded'), wx + ox, wy + oy);
    ctx.drawImage(dragonSilhouette('body'), bx + ox, by + breath + oy);
    ctx.drawImage(dragonSilhouette('headClosed'), hx + ox, hy + oy);
  }
  ctx.drawImage(dragonPart('wingFolded'), wx, wy);
  ctx.drawImage(dragonPart('body'), bx, by + breath);
  ctx.drawImage(dragonPart('headClosed'), hx, hy);
}
