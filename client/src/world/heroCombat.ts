// Hero combat choreography: instead of one looping swing, a fighting hero
// runs seeded "beats" (slash, double slash, thrust, guard stance, feint hop,
// reposition around the foe) so two heroes on one monster stay out of sync.
// Pure timing / pose maths; actors.ts applies it to the LPC body and sword.

import type { LpcAnim } from './lpcHero';

export type BeatKind = 'slash' | 'double' | 'thrust' | 'stance' | 'feint' | 'reposition';

export interface Beat {
  kind: BeatKind;
  start: number;
  dur: number;
  /** Strikes already landed in this beat. */
  hits: number;
  /** Stance shuffle / drill facing side. */
  sign: 1 | -1;
  /** Reposition arc around the foe's feet: centre, radius, start / end angle (rad, y squashed 0.7). */
  arc: { fx: number; fy: number; r: number; a0: number; a1: number } | null;
}

export interface CombatState {
  beat: Beat | null;
  n: number;
  last: BeatKind | null;
  /** A dodge just played: the next beat (back in range) is an attack. */
  afterDodge: boolean;
}

export interface CombatPose {
  anim: LpcAnim;
  frame: number;
  dx: number;
  bob: number;
  /** Blade angle relative to facing on the constrained arc (null = the anim's table angle). */
  bladeRel: number | null;
  /** Thrust: blade fixed at the facing, pushed forward this far (px). */
  thrustPush: number | null;
  /** Impact smear strength 0..1. */
  smear: number;
  /** Strikes reached so far in the beat. */
  impacts: number;
}

/** Slash timing (s): raise, poised hold, fast strike, held follow-through, recover. */
const RAISE = 0.18;
const POISE = 0.25;
const STRIKE = 0.12;
const FOLLOW = 0.2;
const RECOVER = 0.15;
const SLASH_DUR = RAISE + POISE + STRIKE + FOLLOW + RECOVER;
/** Double slash: the first swing's follow-through is cut short, the second winds up quicker. */
const DOUBLE_SPLIT = RAISE + POISE + STRIKE + 0.1;
const RAISE2 = 0.1;
const POISE2 = 0.08;
const DOUBLE_DUR = DOUBLE_SPLIT + RAISE2 + POISE2 + STRIKE + FOLLOW + RECOVER;
/** Constrained arc: raised wind-up and follow-through relative to facing (deg). Never a full turn. */
export const SWING_UP = -110;
export const SWING_FOLLOW = 30;
const STANCE_REL = -60;
export const FEINT_DUR = 0.5;
const REPOSITION_DUR = 0.8;
const REPOSITION_ARC = Math.PI / 3;

const WEIGHTS: Array<[BeatKind, number]> = [
  ['slash', 28],
  ['thrust', 16],
  ['double', 8],
  ['stance', 20],
  ['feint', 20],
  ['reposition', 8],
];

/** Deterministic 0..1 from a hero seed and a beat counter. */
function rand(seed: number, n: number): number {
  let x = (seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function pick(seed: number, n: number, canMove: boolean, last: BeatKind | null): BeatKind {
  const table = WEIGHTS.filter(([k]) => canMove || (k !== 'feint' && k !== 'reposition'));
  const total = table.reduce((s, [, w]) => s + w, 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    let r = rand(seed, n * 7 + attempt) * total;
    for (const [k, w] of table) {
      r -= w;
      if (r <= 0) {
        if (k !== last || attempt === 2) return k;
        break;
      }
    }
  }
  return 'slash';
}

export function createCombat(): CombatState {
  return { beat: null, n: 0, last: null, afterDodge: false };
}

/** Starts the next beat; the first one is a stance of seeded length so heroes start out of step. */
export function nextBeat(cs: CombatState, seed: number, t: number, canMove: boolean, attack = false): Beat {
  const first = cs.beat === null && !attack;
  const roll = rand(seed, cs.n * 11 + 3);
  const kind: BeatKind = attack ? (roll < 0.6 ? 'slash' : roll < 0.85 ? 'thrust' : 'double') : first ? 'stance' : pick(seed, cs.n, canMove, cs.last);
  const r = rand(seed, cs.n * 13 + 5);
  const dur =
    kind === 'slash' || kind === 'thrust'
      ? SLASH_DUR
      : kind === 'double'
        ? DOUBLE_DUR
        : kind === 'stance'
          ? first
            ? 0.25 + r * 0.9
            : 0.6 + r * 0.6
          : kind === 'feint'
            ? FEINT_DUR
            : REPOSITION_DUR;
  cs.n++;
  cs.last = kind;
  cs.beat = { kind, start: t, dur, hits: 0, sign: r < 0.5 ? -1 : 1, arc: null };
  return cs.beat;
}

/** Arc for a reposition: ~60° around the foe at the current range, staying on this side (±60° off horizontal). */
export function repositionArc(hx: number, hy: number, fx: number, fy: number, sign: 1 | -1): Beat['arc'] {
  const r = Math.hypot(hx - fx, (hy - fy) / 0.7);
  if (r < 4) return null;
  const a0 = Math.atan2((hy - fy) / 0.7, hx - fx);
  const base = hx >= fx ? 0 : Math.PI;
  let off = a0 - base;
  while (off > Math.PI) off -= 2 * Math.PI;
  while (off < -Math.PI) off += 2 * Math.PI;
  const dir = off > 0.17 ? -1 : off < -0.17 ? 1 : sign;
  const off1 = Math.max(-REPOSITION_ARC, Math.min(REPOSITION_ARC, off + dir * REPOSITION_ARC));
  // relative step so the walk never wraps the long way round
  return { fx, fy, r, a0, a1: a0 + (off1 - off) };
}

const easeOutCubic = (k: number): number => 1 - (1 - k) ** 3;

function slashPose(s: number, raise: number, poise: number): Omit<CombatPose, 'dx' | 'bob' | 'thrustPush' | 'impacts'> & { landed: boolean } {
  const imp = raise + poise + STRIKE;
  let frame: number;
  let rel: number;
  if (s < raise) {
    const k = s / raise;
    frame = Math.min(2, Math.floor(k * 3));
    rel = SWING_FOLLOW + (SWING_UP - SWING_FOLLOW) * k * k; // ease-in up to the wind-up
  } else if (s < raise + poise) {
    frame = 3;
    rel = SWING_UP; // poised
  } else if (s < imp) {
    frame = 4;
    rel = SWING_UP + (SWING_FOLLOW - SWING_UP) * easeOutCubic((s - raise - poise) / STRIKE); // fast strike
  } else if (s < imp + FOLLOW) {
    frame = 5;
    rel = SWING_FOLLOW;
  } else {
    frame = 0;
    rel = SWING_FOLLOW;
  }
  const smear = s >= imp - 0.05 && s < imp + 0.14 ? 1 - Math.max(0, s - imp) / 0.14 : 0;
  return { anim: 'slash', frame, bladeRel: Math.max(SWING_UP, Math.min(SWING_FOLLOW, rel)), smear, landed: s >= imp };
}

function thrustPose(s: number): { frame: number; push: number; landed: boolean } {
  const imp = RAISE + POISE + STRIKE;
  if (s < RAISE) return { frame: Math.min(3, Math.floor((s / RAISE) * 4)), push: -2 * (s / RAISE), landed: false };
  if (s < RAISE + POISE) return { frame: 3, push: -2, landed: false };
  if (s < imp) return { frame: 4, push: -2 + 8 * easeOutCubic((s - RAISE - POISE) / STRIKE), landed: false };
  if (s < imp + FOLLOW) return { frame: 5, push: 6, landed: true };
  const k = Math.min(1, (s - imp - FOLLOW) / RECOVER);
  return { frame: k < 0.5 ? 6 : 7, push: 6 * (1 - k), landed: true };
}

/** Pose `s` seconds into a beat. */
export function beatPose(b: Beat, s: number, t: number): CombatPose {
  const base: CombatPose = { anim: 'slash', frame: 0, dx: 0, bob: 0, bladeRel: null, thrustPush: null, smear: 0, impacts: 0 };
  switch (b.kind) {
    case 'slash': {
      const p = slashPose(s, RAISE, POISE);
      return { ...base, anim: p.anim, frame: p.frame, bladeRel: p.bladeRel, smear: p.smear, impacts: p.landed ? 1 : 0 };
    }
    case 'double': {
      if (s < DOUBLE_SPLIT) {
        const p = slashPose(s, RAISE, POISE);
        return { ...base, frame: p.frame, bladeRel: p.bladeRel, smear: p.smear, impacts: p.landed ? 1 : 0 };
      }
      const p = slashPose(s - DOUBLE_SPLIT, RAISE2, POISE2);
      return { ...base, frame: p.frame, bladeRel: p.bladeRel, smear: p.smear, impacts: p.landed ? 2 : 1 };
    }
    case 'thrust': {
      const p = thrustPose(s);
      return { ...base, anim: 'thrust', frame: p.frame, thrustPush: p.push, impacts: p.landed ? 1 : 0 };
    }
    case 'stance': {
      // guard: blade raised and still, breathing, shuffling a few px
      const k = s / b.dur;
      return { ...base, frame: 0, bladeRel: STANCE_REL, bob: Math.sin(t * 5.5) > 0.4 ? -1 : 0, dx: Math.round(Math.sin(k * Math.PI * 2) * 3 * b.sign) };
    }
    case 'feint':
      // the hop itself is the dodge animation (actors.ts); keep the guard up
      return { ...base, frame: 0, bladeRel: STANCE_REL };
    case 'reposition':
      return { ...base, anim: 'walk', frame: 1 + (Math.floor(s * 10) % 8) };
  }
}

/** Point on a reposition arc at progress k (smoothstep). */
export function arcPoint(arc: NonNullable<Beat['arc']>, k: number): { x: number; y: number } {
  const e = k * k * (3 - 2 * k);
  const a = arc.a0 + (arc.a1 - arc.a0) * e;
  return { x: arc.fx + Math.cos(a) * arc.r, y: arc.fy + Math.sin(a) * arc.r * 0.7 };
}
