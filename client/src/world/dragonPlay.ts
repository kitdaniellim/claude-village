// The Simone dragon is a friend, never a foe (no fire, no health, nobody attacks her).
// Art: AntumDeluge's "Flying Dragon Rework" of ZaPaper's red dragon (CC-BY 3.0,
// assets/dragon/flying-rework/); hearts: LemCraft heart.png (CC0, assets/icons/lemcraft/).
//
// Play (a hero working at Simone): she takes off, flies loops round the lair while the
// hero chases her; once caught she lands, lowers her head and the hero pets it (little
// hearts, then one big heart), then she curls up and sleeps while the hero goes back to
// work. She wakes with a stretch and flies again, or goes home to her perch.
// WAR: she circles the battle as a companion and now and then lands by an idle-ish hero
// for the same pet-and-sleep visit.

import type { Hero } from './actors';
import { emitSparkBurst, spawn } from './ambient';
import type { AmbientState } from './ambient';
import { WORLD_H, WORLD_W } from './constants';
import { drawPixelEllipse } from './pixel';
import type { Pt, Rect } from './pixel';

const SHEET_URL = 'assets/dragon/flying-rework/flying_dragon-red.png';
const HEART_URL = 'assets/icons/lemcraft/heart.png';
/** 3 frames x 4 facings (rows N, E, S, W), 144x128 cells. */
const CELL_W = 144;
const CELL_H = 128;
const ROW = { N: 0, E: 1, S: 2, W: 3 } as const;
/** World px per sheet px (a ~79 px wingspan beside 24 px heroes). */
const SCALE = 0.55;
/** Cell row of the feet / belly line. */
const FEET_ROW = 96;
/** Her head sits this far in front of her centre when she lowers it (world px). */
const HEAD_DX = 27;
/** The heart png is 11x11 pixel art upscaled 4x: drawn crisply at 1x (little) and 2x (big). */
const HEART_SRC_PX = 4;
const HEART_NATIVE = 11;

const TAKEOFF_DUR = 1.0;
const LAND_DUR = 1.0;
const WAKE_DUR = 1.2;
const CHASE_MIN = 6;
const CHASE_RANGE = 6;
const PET_MIN = 5;
const PET_RANGE = 2;
const SLEEP_MIN = 15;
const SLEEP_RANGE = 10;
const LITTLE_HEART_EVERY = 0.7;
const HEART_LIFE = 1.6;
const BIG_HEART_LIFE = 2.2;
const ZZZ_EVERY = 0.9;
const ZZZ_LIFE = 2.4;
/** Hero chase speed (px/s): faster than the tiring dragon only late in the chase. */
const HERO_RUN = 52;
const HERO_STEP = 40;
const DRAGON_V0 = 110;
const DRAGON_V1 = 30;
/** Loop radius: wide at first, tighter as she tires. */
const LOOP_R0 = 200;
const LOOP_R1 = 120;
const CATCH_DIST = 16;
/** She lands this far from the hero she visits (head toward them). */
const LAND_GAP = 44;
/** Cruise height (px above her shadow) and the perch hover height. */
const CRUISE_Z = 50;
const PERCH_Z = 52;
/** WAR companion loop round the battle. */
const WAR_R = 220;
const WAR_V = 85;

export type PlayPhase = 'off' | 'takeoff' | 'fly' | 'land' | 'pet' | 'sleep' | 'wake' | 'return';

interface Fx {
  x: number;
  y: number;
  t0: number;
  kind: 'heart' | 'bigheart' | 'z';
}

export interface DragonPlay {
  phase: PlayPhase;
  phaseT: number;
  /** Ground point under her, height above it, and velocity. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  /** Loop angle round the lair (play) or the battle (WAR). */
  a: number;
  chaseDur: number;
  /** WAR: circle until this time, then visit someone. */
  flyUntil: number;
  /** The hero she is playing with / visiting. */
  heroId: string | null;
  /** 1 = facing east, -1 = west. */
  face: 1 | -1;
  row: number;
  petDur: number;
  /** Petting starts counting once the hero reaches her head. */
  petStart: number;
  sleepDur: number;
  fx: Fx[];
  nextFxAt: number;
  from: { x: number; y: number; z: number };
  to: Pt;
  nextCheerAt: number;
  mode: 'play' | 'war';
}

export function createDragonPlay(): DragonPlay {
  return {
    phase: 'off', phaseT: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, a: 0, chaseDur: CHASE_MIN, flyUntil: 0, heroId: null, face: -1, row: ROW.W,
    petDur: PET_MIN, petStart: -1, sleepDur: SLEEP_MIN, fx: [], nextFxAt: 0, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0 }, nextCheerAt: 0, mode: 'play',
  };
}

/** False while she is on her perch (the perched sheet dragon draws her then). */
export function dragonPlayActive(dp: DragonPlay): boolean {
  return dp.phase !== 'off';
}

/** The hero petting her head right now, and which way it faces. */
export function petFacing(dp: DragonPlay, heroId: string): { faceRight: boolean } | null {
  if (dp.phase !== 'pet' || dp.heroId !== heroId || dp.petStart < 0) return null;
  return { faceRight: dp.face === -1 };
}

/** Ground she occupies while landed / asleep (heroes and monsters keep off it), or null in the air. */
export function dragonFootprint(dp: DragonPlay): Rect | null {
  if (dp.phase !== 'pet' && dp.phase !== 'sleep' && dp.phase !== 'wake' && !(dp.phase === 'land' && dp.z < 8)) return null;
  return { x: dp.x - 30, y: dp.y - 12, w: 60, h: 16 };
}

const ease = (k: number): number => k * k * (3 - 2 * k);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

function clampWorld(p: Pt): Pt {
  return { x: Math.max(40, Math.min(WORLD_W - 40, p.x)), y: Math.max(70, Math.min(WORLD_H - 24, p.y)) };
}

/** Loop centre pulled in from the map edges so the widest loop stays on the map. */
function loopCentre(c: Pt, r: number): Pt {
  const mx = r + 40;
  const my = r * 0.55 + 18 + 70;
  return { x: Math.max(mx, Math.min(WORLD_W - mx, c.x)), y: Math.max(my, Math.min(WORLD_H - my + 46, c.y)) };
}

/** Ground point on the loop at angle `a`: a squashed ellipse with a lazy figure-eight wobble. */
function loopPoint(c: Pt, a: number, r: number, rMax: number): Pt {
  const cc = loopCentre(c, rMax);
  return clampWorld({ x: cc.x + Math.cos(a) * r, y: cc.y + Math.sin(a) * r * 0.55 + Math.sin(a * 2) * 18 });
}

function setPhase(dp: DragonPlay, p: PlayPhase): void {
  dp.phase = p;
  dp.phaseT = 0;
}

/** Hands the hero back to its normal routing (it walks back to its work / post from where it is). */
function release(dp: DragonPlay, heroes: Map<string, Hero>): void {
  const h = dp.heroId ? heroes.get(dp.heroId) : undefined;
  if (h) {
    h.puppet = false;
    h.moving = false;
    h.targetKey = '';
  }
  dp.heroId = null;
}

/** Walks the puppet hero toward `tg` at `speed`; returns the remaining distance. */
function walkHero(h: Hero, tg: Pt, speed: number, dt: number): number {
  const dx = tg.x - h.x;
  const dy = tg.y - h.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.5) {
    h.moving = false;
    h.arrived = true;
    return d;
  }
  const s = Math.min(d, speed * dt);
  h.x += (dx / d) * s;
  h.y += (dy / d) * s;
  h.walk += s;
  h.moving = true;
  h.arrived = false;
  if (Math.abs(dx) > 0.5) h.facing = dx < 0 ? -1 : 1;
  return d - s;
}

export interface DragonPlayOpts {
  /** Play: the hero working at Simone (no live error), or null. */
  hero: Hero | null;
  heroes: Map<string, Hero>;
  /** Perch ground point (take-off / return) and the lair centre. */
  home: Pt;
  center: Pt;
  /** Where she lies when motion is reduced (by the perch, on the ground). */
  restSpot: Pt;
  /** The mountain: the chasing hero runs round it, never over it. */
  avoid: Rect | null;
  reduced: boolean;
  /** WAR: she circles the battle and visits idle-ish heroes. */
  war: boolean;
  battle: Pt;
  /** Drafted heroes standing idle (formation / waiting): who she may visit. */
  visitable: Hero[];
  /** Everyone else on the field (heroes, monsters): she never lands on top of a fight. */
  crowd: Pt[];
  walkable: (x: number, y: number) => boolean;
  /** Her whole drawn body box (wings and all) is clear of decor, places and banners. */
  bodyClear: (r: Rect) => boolean;
}

/** Advances her state machine and moves the hero she is with. */
export function updateDragonPlay(dp: DragonPlay, o: DragonPlayOpts, dt: number, t: number, st: AmbientState): void {
  dp.phaseT += dt;
  dp.fx = dp.fx.filter((f) => t - f.t0 < (f.kind === 'bigheart' ? BIG_HEART_LIFE : f.kind === 'z' ? ZZZ_LIFE : HEART_LIFE));
  const mode: DragonPlay['mode'] = o.war ? 'war' : 'play';
  if (mode !== dp.mode) {
    // WAR started / ended: let go of whoever she was with (a sleeping dragon keeps sleeping)
    dp.mode = mode;
    if (dp.phase !== 'sleep') release(dp, o.heroes);
    if (dp.phase === 'fly' || dp.phase === 'land' || dp.phase === 'pet') takeoff(dp, o, t);
  }
  const want = dp.mode === 'war' || (o.hero !== null && !o.hero.removing);
  const px = dp.x;
  const py = dp.y;

  switch (dp.phase) {
    case 'off':
      if (!want || (o.reduced && dp.mode === 'war')) return;
      dp.x = o.home.x;
      dp.y = o.home.y;
      dp.z = PERCH_Z;
      if (o.reduced) {
        // no flight: she lies down by the perch for the visit
        dp.x = o.restSpot.x;
        dp.y = o.restSpot.y;
        dp.z = 0;
        dp.face = -1;
        startPet(dp, o.hero, t);
        return;
      }
      takeoff(dp, o, t);
      return;
    case 'return': {
      // fly home to the perch (or turn round if someone wants her again)
      if (want && !o.reduced) {
        takeoff(dp, o, t);
        break;
      }
      const k = Math.min(1, dp.phaseT / 1.6);
      dp.x = lerp(dp.from.x, o.home.x, ease(k));
      dp.y = lerp(dp.from.y, o.home.y, ease(k));
      dp.z = lerp(dp.from.z, PERCH_Z, ease(k));
      if (k >= 1) setPhase(dp, 'off');
      break;
    }
    case 'takeoff': {
      const k = Math.min(1, dp.phaseT / TAKEOFF_DUR);
      const p = flightPoint(dp, o, dp.a, 0);
      dp.x = lerp(dp.from.x, p.x, ease(k));
      dp.y = lerp(dp.from.y, p.y, ease(k));
      dp.z = lerp(dp.from.z, CRUISE_Z, ease(k));
      const h = dp.mode === 'play' ? playHero(dp, o) : null;
      if (h) chase(h, dp, dt, t, st, o.avoid);
      if (!want) homeward(dp);
      else if (k >= 1) setPhase(dp, 'fly');
      break;
    }
    case 'fly': {
      if (!want) {
        homeward(dp);
        break;
      }
      if (dp.mode === 'war') warFly(dp, o, dt, t);
      else playFly(dp, o, dt, t, st);
      break;
    }
    case 'land': {
      const k = Math.min(1, dp.phaseT / LAND_DUR);
      dp.x = lerp(dp.from.x, dp.to.x, ease(k));
      dp.y = lerp(dp.from.y, dp.to.y, ease(k));
      dp.z = lerp(dp.from.z, 0, ease(Math.min(1, k * 1.15)));
      const h = dp.heroId ? o.heroes.get(dp.heroId) : undefined;
      if (h) {
        h.puppet = true;
        h.moving = false;
      }
      if (k >= 1) {
        for (let i = 0; i < 8; i++) spawn(st, { x: dp.x + (Math.random() - 0.5) * 30, y: dp.y + 1, vx: (Math.random() - 0.5) * 30, vy: -4 - Math.random() * 6, age: 0, ttl: 0.6, size: 3, color: '#c8b89a', kind: 'puff' });
        if (h) dp.face = h.x < dp.x ? -1 : 1;
        startPet(dp, h ?? null, t);
      }
      break;
    }
    case 'pet': {
      const h = dp.heroId ? o.heroes.get(dp.heroId) : undefined;
      if (!h || h.removing || (dp.mode === 'play' && !want)) {
        fallAsleep(dp, o, t);
        break;
      }
      h.puppet = true;
      if (h.dragging) break;
      // the hero steps up to her lowered head, faces it and strokes it
      const head = headPoint(dp);
      const spot = { x: head.x + dp.face * 9, y: dp.y + 1 };
      if (dp.petStart < 0) {
        if (walkHero(h, spot, HERO_STEP, dt) < 1) {
          h.moving = false;
          h.arrived = true;
          dp.petStart = t;
          dp.nextFxAt = t + 0.3;
        }
        break;
      }
      h.moving = false;
      h.arrived = true;
      if (t >= dp.nextFxAt) {
        dp.nextFxAt = t + LITTLE_HEART_EVERY;
        dp.fx.push({ x: head.x + (Math.random() - 0.5) * 6, y: head.y - 6, t0: t, kind: 'heart' });
      }
      if (t - dp.petStart >= dp.petDur) {
        // one big heart over her head, then she curls up to sleep
        dp.fx.push({ x: head.x, y: head.y - 14, t0: t, kind: 'bigheart' });
        emitSparkBurst(st, { x: head.x, y: head.y - 12 }, '#ff8fd8', 10, 60);
        fallAsleep(dp, o, t);
      }
      break;
    }
    case 'sleep': {
      if (t >= dp.nextFxAt) {
        dp.nextFxAt = t + ZZZ_EVERY;
        const head = headPoint(dp);
        dp.fx.push({ x: head.x, y: head.y - 4, t0: t, kind: 'z' });
      }
      if (dp.phaseT >= dp.sleepDur) setPhase(dp, 'wake');
      break;
    }
    case 'wake': {
      if (dp.phaseT >= WAKE_DUR) {
        if (o.reduced) {
          // no flight: wait for the next visit on the ground
          if (want) startPet(dp, dp.mode === 'play' ? o.hero : (o.visitable[0] ?? null), t);
          else setPhase(dp, 'off');
        } else if (want) takeoff(dp, o, t);
        else homeward(dp);
      }
      break;
    }
  }
  if (dp.phase === 'fly' || dp.phase === 'takeoff' || dp.phase === 'return') {
    dp.vx = (dp.x - px) / Math.max(dt, 1e-3);
    dp.vy = (dp.y - py) / Math.max(dt, 1e-3);
    if (Math.abs(dp.vx) > 4) dp.face = dp.vx > 0 ? 1 : -1;
  } else {
    dp.vx = 0;
    dp.vy = 0;
  }
}

function homeward(dp: DragonPlay): void {
  dp.from = { x: dp.x, y: dp.y, z: dp.z };
  setPhase(dp, 'return');
}

/** The play hero (working at Simone), claimed as her puppet. */
function playHero(dp: DragonPlay, o: DragonPlayOpts): Hero | null {
  const h = o.hero && !o.hero.removing ? o.hero : null;
  if (dp.heroId && dp.heroId !== h?.sessionId) release(dp, o.heroes);
  if (h) {
    dp.heroId = h.sessionId;
    h.puppet = true;
  }
  return h;
}

function takeoff(dp: DragonPlay, o: DragonPlayOpts, t: number): void {
  dp.from = { x: dp.x, y: dp.y, z: dp.z };
  const c = dp.mode === 'war' ? o.battle : o.center;
  const r = dp.mode === 'war' ? WAR_R : LOOP_R0;
  const cc = loopCentre(c, r);
  dp.a = Math.atan2((dp.y - cc.y) / 0.55, dp.x - cc.x);
  dp.chaseDur = CHASE_MIN + Math.random() * CHASE_RANGE;
  dp.flyUntil = t + TAKEOFF_DUR + 6 + Math.random() * 6;
  dp.nextCheerAt = t + 0.6;
  setPhase(dp, 'takeoff');
}

/** Where the flight loop puts her at angle `a` (k = how tired she is, play only). */
function flightPoint(dp: DragonPlay, o: DragonPlayOpts, a: number, k: number): Pt {
  if (dp.mode === 'war') return loopPoint(o.battle, a, WAR_R, WAR_R);
  return loopPoint(o.center, a, lerp(LOOP_R0, LOOP_R1, k), LOOP_R0);
}

/** WAR: a lazy loop over the battle; after a while she drops in on an idle-ish hero. */
function warFly(dp: DragonPlay, o: DragonPlayOpts, dt: number, t: number): void {
  dp.a += (WAR_V / WAR_R) * dt;
  const p = flightPoint(dp, o, dp.a, 0);
  dp.x = p.x;
  dp.y = p.y;
  dp.z = CRUISE_Z + 10 + Math.sin(dp.a * 1.7) * 8;
  if (t < dp.flyUntil) return;
  const h = o.visitable.reduce<Hero | null>((b, c) => (!b || Math.hypot(c.x - dp.x, c.y - dp.y) < Math.hypot(b.x - dp.x, b.y - dp.y) ? c : b), null);
  if (!h) {
    dp.flyUntil = t + 3;
    return;
  }
  const spot = landSpot(h, dp, o);
  if (!spot) {
    dp.flyUntil = t + 3;
    return;
  }
  dp.heroId = h.sessionId;
  h.puppet = true;
  dp.from = { x: dp.x, y: dp.y, z: dp.z };
  dp.to = spot;
  setPhase(dp, 'land');
}

/** Play: loops round the lair while the hero chases; she tires, sinks and lands once caught. */
function playFly(dp: DragonPlay, o: DragonPlayOpts, dt: number, t: number, st: AmbientState): void {
  const hero = playHero(dp, o);
  if (!hero) {
    homeward(dp);
    return;
  }
  const k = Math.min(1, dp.phaseT / dp.chaseDur);
  const r = lerp(LOOP_R0, LOOP_R1, k);
  const v = lerp(DRAGON_V0, DRAGON_V1, k);
  dp.a += (v / r) * dt;
  // worn out: she drifts down toward the hero for the last stretch so the chase ends in a catch
  const lp = flightPoint(dp, o, dp.a, k);
  const tire = Math.max(0, (k - 0.65) / 0.35);
  const near = { x: hero.x + (lp.x >= hero.x ? 1 : -1) * 14, y: hero.y - 2 };
  dp.x = lerp(lp.x, near.x, tire * tire);
  dp.y = lerp(lp.y, near.y, tire * tire);
  const swoop = Math.max(0, Math.sin(dp.a * 0.5 + 1.3) - 0.85) / 0.15;
  dp.z = Math.max(4, lerp(CRUISE_Z, 14, k) + Math.sin(dp.a * 1.7) * 8 - swoop * 22);
  const d = chase(hero, dp, dt, t, st, o.avoid);
  if ((d < CATCH_DIST && dp.phaseT >= dp.chaseDur * 0.55) || dp.phaseT >= dp.chaseDur) {
    emitSparkBurst(st, { x: hero.x, y: hero.y - 22 }, '#ffd97a', 10, 70);
    const spot = landSpot(hero, dp, o);
    if (!spot) {
      // nowhere clear to lie down here yet: keep circling a little longer and try again
      dp.phaseT = dp.chaseDur * 0.8;
      return;
    }
    dp.from = { x: dp.x, y: dp.y, z: dp.z };
    dp.to = spot;
    setPhase(dp, 'land');
  }
}

/** Her drawn body box standing at ground point `q` (wings up included): about 80 x 54 px. */
function bodyBox(q: Pt): Rect {
  return { x: q.x - 40, y: q.y - 50, w: 80, h: 54 };
}

/**
 * Where to land for `h`: LAND_GAP px beside it (her side first), else the nearest spot on rings out to 150 px.
 * The feet line must be walkable and her whole body box clear of decor, places, banners and everyone else.
 */
function landSpot(h: Hero, dp: DragonPlay, o: DragonPlayOpts): Pt | null {
  const ok = (q: Pt): boolean => {
    const box = bodyBox(q);
    const crowdClear = o.crowd.every((c) => Math.hypot(c.x - h.x, c.y - h.y) < 1 || c.x < box.x - 6 || c.x > box.x + box.w + 6 || c.y < box.y || c.y > box.y + box.h + 6);
    return crowdClear && o.walkable(q.x, q.y) && o.walkable(q.x - 26, q.y) && o.walkable(q.x + 26, q.y) && o.bodyClear(box);
  };
  const pref = dp.x >= h.x ? 1 : -1;
  for (const side of [pref, -pref]) {
    for (const dy of [0, -10, 10, -20, 20]) {
      const q = clampWorld({ x: h.x + side * LAND_GAP, y: h.y - 1 + dy });
      if (ok(q)) return q;
    }
  }
  for (let r = 56; r <= 150; r += 12) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const q = clampWorld({ x: h.x + Math.cos(a) * r, y: h.y + Math.sin(a) * r * 0.7 });
      if (ok(q)) return q;
    }
  }
  return null;
}

/** Her lowered head (world px), on the side she faces. */
function headPoint(dp: DragonPlay): Pt {
  return { x: dp.x + dp.face * HEAD_DX, y: dp.y - 8 };
}

function startPet(dp: DragonPlay, h: Hero | null, t: number): void {
  setPhase(dp, 'pet');
  dp.petStart = -1;
  dp.petDur = PET_MIN + Math.random() * PET_RANGE;
  dp.nextFxAt = t;
  if (h) {
    dp.heroId = h.sessionId;
    h.puppet = true;
  }
}

function fallAsleep(dp: DragonPlay, o: DragonPlayOpts, t: number): void {
  release(dp, o.heroes); // the hero walks back to its work
  setPhase(dp, 'sleep');
  dp.sleepDur = SLEEP_MIN + Math.random() * SLEEP_RANGE;
  dp.nextFxAt = t + 0.6;
}

/** The hero runs at where she is heading (cutting corners); returns the gap to her shadow. */
function chase(h: Hero, dp: DragonPlay, dt: number, t: number, st: AmbientState, avoid: Rect | null): number {
  if (h.dragging) return Infinity;
  const lead = 0.6;
  const tg = outside(clampWorld({ x: dp.x + dp.vx * lead, y: dp.y + dp.vy * lead }), avoid);
  walkHero(h, detour({ x: h.x, y: h.y }, tg, avoid), HERO_RUN, dt);
  // never end a step on the mountain: slide back out to its nearest edge
  const out = outside({ x: h.x, y: h.y }, avoid);
  h.x = out.x;
  h.y = out.y;
  if (t >= dp.nextCheerAt) {
    // excited little sparkles over the hero's head
    dp.nextCheerAt = t + 0.7 + Math.random() * 0.6;
    for (let i = 0; i < 3; i++) spawn(st, { x: h.x + (Math.random() - 0.5) * 8, y: h.y - 26, vx: (Math.random() - 0.5) * 16, vy: -18, age: 0, ttl: 0.5, size: 1, color: '#ffd97a', kind: 'sparkle' });
  }
  return Math.hypot(h.x - dp.x, h.y - dp.y);
}

/** True when the segment a→b passes through `r` (sampled; the rect is big and steps are short). */
function crosses(a: Pt, b: Pt, r: Rect): boolean {
  for (let i = 1; i < 12; i++) {
    const k = i / 12;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

/** Next waypoint toward `tg`: straight if clear, else the corner of `r` (padded) that goes round it shortest. */
function detour(from: Pt, tg: Pt, r: Rect | null): Pt {
  if (!r || !crosses(from, tg, r)) return tg;
  const pad = 6;
  const corners: Pt[] = [
    { x: r.x - pad, y: r.y - pad },
    { x: r.x + r.w + pad, y: r.y - pad },
    { x: r.x - pad, y: r.y + r.h + pad },
    { x: r.x + r.w + pad, y: r.y + r.h + pad },
  ].map(clampWorld);
  let best = tg;
  let bestD = Infinity;
  for (const c of corners) {
    if (crosses(from, c, r)) continue;
    const d = Math.hypot(c.x - from.x, c.y - from.y) + Math.hypot(tg.x - c.x, tg.y - c.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** `p`, pushed out of `r` to its nearest edge (unchanged when outside). */
function outside(p: Pt, r: Rect | null): Pt {
  if (!r || p.x <= r.x || p.x >= r.x + r.w || p.y <= r.y || p.y >= r.y + r.h) return p;
  const dl = p.x - r.x;
  const dr = r.x + r.w - p.x;
  const du = p.y - r.y;
  const dd = r.y + r.h - p.y;
  const m = Math.min(dl, dr, du, dd);
  if (m === dl) return { x: r.x, y: p.y };
  if (m === dr) return { x: r.x + r.w, y: p.y };
  if (m === du) return { x: p.x, y: r.y };
  return { x: p.x, y: r.y + r.h };
}

// ── drawing ──────────────────────────────────────────────────────────────────

type Img = { img: HTMLImageElement; ok: boolean };
const imgs = new Map<string, Img>();
function image(url: string): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let e = imgs.get(url);
  if (!e) {
    const img = new Image();
    img.decoding = 'async';
    const entry: Img = { img, ok: false };
    img.onload = () => {
      entry.ok = true;
    };
    img.src = `${import.meta.env.BASE_URL}${url}`;
    imgs.set(url, entry);
    e = entry;
  }
  return e.ok ? e.img : null;
}

/** The heart at its native 11 px (one sample per 4x4 block of the png), cached. */
let heartNative: HTMLCanvasElement | null = null;
function heartSprite(): HTMLCanvasElement | null {
  if (heartNative) return heartNative;
  const img = image(HEART_URL);
  if (!img || typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = HEART_NATIVE;
  cv.height = HEART_NATIVE;
  const c = cv.getContext('2d');
  if (!c) return null;
  c.imageSmoothingEnabled = false;
  c.drawImage(img, 0, 0, HEART_NATIVE * HEART_SRC_PX, HEART_NATIVE * HEART_SRC_PX, 0, 0, HEART_NATIVE, HEART_NATIVE);
  heartNative = cv;
  return cv;
}

/** Starts loading her sheet and the heart (idempotent). */
export function preloadDragonPlay(): void {
  image(SHEET_URL);
  heartSprite();
}

/** Sort key for painter order: on the ground she sorts with the heroes; airborne she draws on top. */
export function dragonPlaySortY(dp: DragonPlay): number {
  return dp.z > 6 ? dp.y + 100000 : dp.y;
}

/** Draws her shadow and body (flying, landing, head lowered for petting, curled asleep, stretching awake). */
export function drawDragonPlay(ctx: CanvasRenderingContext2D, dp: DragonPlay, t: number): boolean {
  const img = image(SHEET_URL);
  if (!img) return false;
  const grounded = dp.phase === 'pet' || dp.phase === 'sleep' || dp.phase === 'wake' || dp.phase === 'land';
  // heading → facing row; on the ground she faces dp.face
  const speed = Math.hypot(dp.vx, dp.vy);
  if (grounded) dp.row = dp.face === 1 ? ROW.E : ROW.W;
  else if (speed > 4) dp.row = Math.abs(dp.vx) >= Math.abs(dp.vy) * 0.7 ? (dp.vx > 0 ? ROW.E : ROW.W) : dp.vy < 0 ? ROW.N : ROW.S;
  // grounded (petted / asleep / first beat of waking): belly on the ground, legs tucked out of sight
  const wakeK = dp.phase === 'wake' ? dp.phaseT / WAKE_DUR : 1;
  const lying = dp.phase === 'pet' || dp.phase === 'sleep' || (dp.phase === 'wake' && wakeK < 0.35);
  // shadow: a tight dark contact patch under her when lying; shrinks and fades with height in the air
  if (lying) drawPixelEllipse(ctx, Math.round(dp.x) - dp.face * 3, Math.round(dp.y) - 1, 22, 3, 'rgba(20,16,8,0.42)');
  else {
    const sw = Math.max(10, Math.round(26 - dp.z * 0.25));
    drawPixelEllipse(ctx, Math.round(dp.x), Math.round(dp.y), sw, 4, `rgba(20,16,8,${Math.max(0.12, 0.32 - dp.z * 0.003).toFixed(3)})`);
  }
  // wings: ping-pong flap in the air; on the ground the level-wings frame (the sheet has no lying pose)
  const fps = dp.phase === 'takeoff' ? 11 : dp.phase === 'land' ? 5 : 7;
  const seq = [0, 1, 2, 1];
  let col = seq[Math.floor(t * fps) % seq.length] ?? 0;
  let eyesClosed = false;
  let lift = 0;
  let tilt = 0;
  if (dp.phase === 'pet') {
    // lying, head raised a little toward the hero, eyes open
    col = 1;
    tilt = -0.03;
  } else if (dp.phase === 'sleep') {
    // dozing on her belly: eyes closed, a slow 1 px breathing bob (never squashed)
    col = 1;
    eyesClosed = true;
    lift = Math.sin(t * 1.2) > 0 ? 1 : 0;
  } else if (dp.phase === 'wake') {
    // eyes open, then she stands up into a stretch (wings up, a little lift) and settles
    eyesClosed = wakeK < 0.2;
    col = wakeK >= 0.35 && wakeK < 0.75 ? 0 : 1;
    lift = wakeK >= 0.35 && wakeK < 0.75 ? Math.round(Math.sin(((wakeK - 0.35) / 0.4) * Math.PI) * 3) : 0;
  }
  const w = CELL_W * SCALE;
  const h = CELL_H * SCALE;
  const fx = Math.round(dp.x);
  const fy = Math.round(dp.y - dp.z) - lift;
  ctx.save();
  ctx.translate(fx, fy);
  if (tilt !== 0) ctx.rotate(dp.face * tilt);
  else if (!grounded) {
    // bank into the turn
    const bank = Math.max(-0.22, Math.min(0.22, dp.vy * 0.004)) * (dp.row === ROW.W ? -1 : 1);
    if (dp.row === ROW.E || dp.row === ROW.W) ctx.rotate(bank);
  }
  ctx.imageSmoothingEnabled = false;
  const ground = lying ? groundedFrame(img, dp.row, eyesClosed) : null;
  if (ground) {
    // the frame cut at her belly line, that line set on the ground
    ctx.drawImage(ground, 0, 0, CELL_W, BELLY_ROW, -w / 2, -BELLY_ROW * SCALE, w, BELLY_ROW * SCALE);
  } else ctx.drawImage(img, col * CELL_W, dp.row * CELL_H, CELL_W, CELL_H, -w / 2, -FEET_ROW * SCALE, w, h);
  ctx.restore();
  // soft grass contact over the cut so she reads as lying on her belly
  if (ground) drawPixelEllipse(ctx, Math.round(dp.x) - dp.face * 3, Math.round(dp.y) - 1, 18, 1, 'rgba(24,40,14,0.45)');
  return true;
}

/** Eye pixels of the level-wings frame per facing row (cell px): x / y of the eyelid line. */
const EYE: Partial<Record<number, { x: number; y: number }>> = { [ROW.E]: { x: 109, y: 66 }, [ROW.W]: { x: 31, y: 66 } };
/**
 * Belly line of the level-wings frame (cell rows): below it only the dangling legs remain (row 82 still has
 * 59 opaque px, row 83 drops to the leg tips). Cutting here and setting it on the ground makes her lie down.
 */
const BELLY_ROW = 83;
const groundedFrames = new Map<string, HTMLCanvasElement>();

/** Her level-wings frame cut at the belly line, optionally with her eye painted shut (a 4x2 dark lid, body red above). */
function groundedFrame(img: HTMLImageElement, row: number, eyesClosed: boolean): HTMLCanvasElement | null {
  const eye = EYE[row];
  if (!eye || typeof document === 'undefined') return null;
  const key = `${row}:${eyesClosed ? 1 : 0}`;
  const hit = groundedFrames.get(key);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = CELL_W;
  cv.height = BELLY_ROW;
  const c = cv.getContext('2d');
  if (!c) return null;
  c.imageSmoothingEnabled = false;
  c.drawImage(img, CELL_W, row * CELL_H, CELL_W, BELLY_ROW, 0, 0, CELL_W, BELLY_ROW);
  if (eyesClosed) {
    c.fillStyle = '#a8202f'; // brow: body red over the socket highlight
    c.fillRect(eye.x + 1, eye.y - 1, 2, 1);
    c.fillStyle = '#4c000e'; // the closed lid (2 px tall so it survives the 0.55x draw)
    c.fillRect(eye.x, eye.y, 4, 2);
  }
  groundedFrames.set(key, cv);
  return cv;
}

/** Hearts from her head while she is petted (little, 1x), the big heart (2x) when it ends, and z z z while she sleeps. */
export function drawDragonFx(ctx: CanvasRenderingContext2D, dp: DragonPlay, t: number, reduced: boolean): void {
  const heart = heartSprite();
  for (const f of dp.fx) {
    const life = f.kind === 'bigheart' ? BIG_HEART_LIFE : f.kind === 'z' ? ZZZ_LIFE : HEART_LIFE;
    const k = (t - f.t0) / life;
    const fade = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    ctx.save();
    ctx.globalAlpha *= fade;
    if (f.kind === 'z') {
      // "z" drifting up and to the side, growing a little
      const x = Math.round(f.x + (reduced ? 0 : k * 10 + Math.sin(k * 6) * 2));
      const y = Math.round(f.y - (reduced ? 0 : k * 16));
      ctx.font = `bold ${k < 0.4 ? 6 : 7}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1a1410';
      ctx.strokeText('z', x, y);
      ctx.fillStyle = '#d7dce8';
      ctx.fillText('z', x, y);
    } else if (heart) {
      // crisp: whole-pixel positions, 1x little hearts, a 2x big one that pops in
      const sc = f.kind === 'bigheart' ? (k < 0.12 ? 3 : 2) : 1;
      const rise = reduced ? 0 : f.kind === 'bigheart' ? k * 10 : k * 16;
      const bob = reduced || f.kind === 'bigheart' ? 0 : Math.round(Math.sin(k * Math.PI * 3) * 2);
      const s = HEART_NATIVE * sc;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(heart, Math.round(f.x + bob - s / 2), Math.round(f.y - rise - s / 2), s, s);
    }
    ctx.restore();
  }
}
