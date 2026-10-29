// Monsters: a tool error puts one beside the hero handling it (errorStreak
// 1 = bug/eyeball, 2 = goblin, 3+ = ogre). It idles and taunts until the
// error clears or the hero leaves, then takes a hit and dies — but stays on
// screen for at least MIN_LIFE so instant fixes are still visible. Driven
// purely by AgentState.lastError / errorStreak; nothing here talks back.
// WAR mode adds *practice* monsters (simulated, tied to no session) that die
// after a few seconds of being attacked and respawn elsewhere.

import type { Hero } from './actors';
import { emitSparkBurst, spawn } from './ambient';
import type { AmbientState } from './ambient';
import { WORLD_W } from './constants';
import { drawPixelDisc, drawPixelEllipse, drawPixelRing, hash32 } from './pixel';
import type { Pt } from './pixel';
import { isWalkable, nearestWalkable } from './terrain';
import type { World } from './terrain';
import { drawMonsterFrame, monsterHasAnim, monsterReach, monsterSheetReady, monsterSpriteHeight, preloadMonsters } from './monsterSprite';
import type { MonsterAnim, MonsterKind } from './monsterSprite';

export type MonsterPhase = 'spawn' | 'idle' | 'hit' | 'dying';

export interface Monster {
  sessionId: string;
  kind: MonsterKind;
  tool: string | null;
  detail: string | null;
  /** Feet centre in world px (the bug hovers above it). */
  x: number;
  y: number;
  /** Which side of its hero it stands on. */
  side: 1 | -1;
  phase: MonsterPhase;
  phaseT: number;
  bornAt: number;
  /** The error cleared (or the hero left): die once MIN_LIFE has passed. */
  doomed: boolean;
  seed: number;
  tauntAt: number;
  tauntUntil: number;
  moving: boolean;
  /** Last hero strike (hit flash + knock-back). */
  flinchAt: number;
  nextFlinchAt: number;
  /** Fixed spot at the failing file's building (null: it follows its hero). */
  anchor: Pt | null;
  /** When the current attack swing started (Village makes the target hero dodge). */
  attackAt: number;
  /** Where its hero should stand to fight (they walk to meet there); null = it follows its hero. */
  heroAt: Pt | null;
  /** The hero's place/repo when heroAt was set (Village only honours heroAt while the hero still belongs there). */
  homeKey: string | null;
  /** Practice monsters: spawn point (they walk out at most PRACTICE_ROAM from it). */
  origin: Pt;
  /** A hero is fighting it (attacks only then). */
  engaged: boolean;
  /** Walk row only while the position really changed in the last ~100 ms (no walking in place). */
  walkRef: Pt;
  lastMovedAt: number;
  /** Last hit shown with a flash + stagger (rate-limited so several attackers don't strobe it). */
  flashAt: number;
  /** Prowl centre while fighting (its stand point); war rings are laid round this, not the live x/y. */
  base: Pt;
  /** Which way it looks: 1 = left (its foe is to its left), -1 = right. Live from the foe's position. */
  face: 1 | -1;
  /** Prowling: the current pacing target, when to give up on it, and a step counter for the pattern. */
  prowlTo: Pt | null;
  prowlUntil: number;
  prowlN: number;
  prowling: boolean;
  /** Still walking up to its fight (no attacks until it gets there). */
  approaching: boolean;
  /** WAR practice dummy: no session behind it; dies after `toughness` sword hits. */
  simulated: boolean;
  damage: number;
  toughness: number;
}

/** Hero-to-monster distance (feet centres) at which the sword tip reaches the monster on the strike frame. */
export function monsterGap(kind: MonsterKind): number {
  return kind === 'ogre' ? 20 : kind === 'goblin' ? 16 : 14;
}
/** Monsters spawn this far from a standing hero and walk in; they meet halfway. */
const SPAWN_DIST = 56;
/** An anchored monster walks this far out of its door to meet the hero. */
const ANCHOR_WALK = 24;
/** Walking speed (px/s); a monster left far behind a walking hero jogs. */
const WALK_SPEED = 30;
/** Shortest gap between hit flashes (two or three heroes hitting one monster must not strobe it). */
const FLASH_GAP = 0.3;
/** Prowl speed while fighting: the ogre paces and circles (it has no real idle), the others shift lightly. */
const PROWL_SPEED: Record<MonsterKind, number> = { ogre: 11, goblin: 7, bug: 5 };
/** Within this of its stand point it prowls instead of walking up. */
const PROWL_ZONE = 14;
const CATCHUP_SPEED = 64;
/** Attack: a clear wind-up (telegraph), a fast lunge, a held blow, then recovery; the hero dodges right at the strike. */
export const MONSTER_WINDUP = 0.4;
const LUNGE = 0.15;
const LUNGE_HOLD = 0.35;
const RECOVERY = 0.4;
const ATTACK_DUR = MONSTER_WINDUP + LUNGE + LUNGE_HOLD + RECOVERY;
/** Seconds from the start of an attack to the blow landing (end of the lunge). */
export const MONSTER_IMPACT = MONSTER_WINDUP + LUNGE;
/** Lunge toward the hero at the blow (world px). */
function lungePx(kind: MonsterKind): number {
  return kind === 'bug' ? 6 : 5;
}
/** Half the hero's body width, and the margin the dodge keeps clear of the blow. */
const HERO_HALF = 8;
const CLEAR_MARGIN = 4;

/** Distance from the monster's feet the hero's centre must be at on the impact frame to stay clear of the attack (frame extent + lunge). */
export function attackClearance(m: Monster): number {
  return monsterReach(m.kind) + lungePx(m.kind) + HERO_HALF + CLEAR_MARGIN;
}
/** Wind-up length baked into the sheets' attack rows (3 frames at 10 fps). */
const SHEET_WINDUP = 0.3;
const MIN_LIFE = 1.5;
const SPAWN_DUR = 0.28;
const HIT_DUR = 0.22;
const DIE_DUR = 0.6;
/** Sheets without a death row: tip over in FALL_DUR, lie there, fade out by FALL_DIE_DUR. */
const FALL_DUR = 0.4;
const FALL_DIE_DUR = 1.0;
const FLASH_DUR = 0.08;
const BUG_HOVER = 14;

export function kindForStreak(n: number): MonsterKind {
  return n >= 3 ? 'ogre' : n === 2 ? 'goblin' : 'bug';
}

export function monsterAlive(m: Monster): boolean {
  return m.phase === 'spawn' || m.phase === 'idle';
}

/** Feet-to-head height as drawn (the programmatic stand-in's while no sheet is ready). */
function bodyHeight(kind: MonsterKind): number {
  return monsterSpriteHeight(kind) ?? (kind === 'ogre' ? 26 : 16);
}

/** Point heroes aim at (chest height). */
export function monsterCentre(m: Monster): Pt {
  return { x: m.x, y: m.y - (m.kind === 'bug' ? BUG_HOVER + 8 : Math.round(bodyHeight(m.kind) * 0.5)) };
}

/** Programmatic fall instead of a death row (the user-preview goblin / ogre have none). */
function fallsOver(kind: MonsterKind): boolean {
  return kind !== 'bug' && !monsterHasAnim(kind, 'death');
}

function dieDur(m: Monster): number {
  return fallsOver(m.kind) ? FALL_DIE_DUR : DIE_DUR;
}

export function monsterHit(m: Monster, wx: number, wy: number, r: number): boolean {
  const c = monsterCentre(m);
  return (c.x - wx) ** 2 + (c.y - wy) ** 2 < r * r;
}

function targetFor(h: Hero, side: 1 | -1, kind: MonsterKind): Pt {
  return { x: h.x + side * monsterGap(kind), y: h.y + 1 };
}

/** Room on that side of the hero: inside the world and the hero's city walls, clear of other monsters. */
function sideFits(h: Hero, side: 1 | -1, world: World, others: Iterable<Monster>): boolean {
  const x = h.x + side * SPAWN_DIST;
  if (x < 24 || x > WORLD_W - 24) return false;
  if (!isWalkable(world, x, h.y + 1)) return false;
  const g = world.byId.get(h.placeId);
  if (g && g.kind === 'city' && (x < g.rect.x + 20 || x > g.rect.x + g.rect.w - 20)) return false;
  for (const o of others) if (o.sessionId !== h.sessionId && Math.abs(o.x - x) < 28 && Math.abs(o.y - h.y) < 24) return false;
  return true;
}

function pickSide(h: Hero, world: World, others: Iterable<Monster>): 1 | -1 {
  const pref: 1 | -1 = h.facing === -1 ? -1 : 1;
  const other: 1 | -1 = pref === 1 ? -1 : 1;
  return sideFits(h, pref, world, others) || !sideFits(h, other, world, others) ? pref : other;
}

function poof(st: AmbientState, at: Pt, n: number, color = '#d9d4cc'): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 14 + Math.random() * 22;
    spawn(st, { x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - 10, age: 0, ttl: 0.5 + Math.random() * 0.3, size: 2 + Math.random() * 2, color, kind: 'puff' });
  }
}

/** Side for a monster pinned at `at`: its hero stands on the other side, inside the place's walls. */
function anchorSide(at: Pt, world: World): 1 | -1 {
  const g = world.places.find((p) => at.x >= p.rect.x && at.x <= p.rect.x + p.rect.w && at.y >= p.rect.y && at.y <= p.rect.y + p.rect.h);
  const heroX = at.x - monsterGap('ogre');
  return !g || heroX > g.rect.x + 12 ? 1 : -1;
}

/** Hero strike frame: white flash + a short knock-back. */
export function strikeMonster(m: Monster, t: number): void {
  if (!monsterAlive(m) || t - m.flinchAt <= 0.08) return;
  m.flinchAt = t;
  if (t - m.flashAt >= FLASH_GAP) m.flashAt = t;
  // practice monsters lose one hit point per blow (real ones only die when the error clears)
  if (m.simulated && m.phase === 'idle') m.damage += 1;
}

/** One walking step toward `tg` (at most `step` px); `moving` only while the position changes. */
function walkToward(m: Monster, tg: Pt, step: number, world: World | null = null): void {
  const dx = tg.x - m.x;
  const dy = tg.y - m.y;
  const dist = Math.hypot(dx, dy);
  // dead band: never shuffle in place for sub-pixel corrections
  if (dist < 1.5) return;
  const s = Math.min(dist, step);
  let ux = dx / dist;
  let uy = dy / dist;
  if (world && !isWalkable(world, m.x + ux * s, m.y + uy * s, 4) && isWalkable(world, m.x, m.y, 4)) {
    // blocked (pond bank, trunk, building): veer round it, nearest heading first
    const base = Math.atan2(uy, ux);
    let found = false;
    for (const off of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
      const a = base + off;
      if (isWalkable(world, m.x + Math.cos(a) * s, m.y + Math.sin(a) * s, 4)) {
        ux = Math.cos(a);
        uy = Math.sin(a);
        found = true;
        break;
      }
    }
    if (!found) return;
  }
  m.x += ux * s;
  m.y += uy * s;
  m.moving = s > 0.01;
}

/** Deterministic 0..1 from the monster seed and a counter. */
function rand01(seed: number, n: number): number {
  let x = (seed * 2654435761 + n * 40503) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
}

/**
 * Pacing round its stand point while it fights: the ogre side-steps, arcs round its foe and shuffles
 * back and forth (it has no usable idle, so it never stands still); the goblin shuffles; the eyeball drifts.
 * Targets that fail isWalkable fall back to the stand point.
 */
function prowl(m: Monster, foe: Pt | null, world: World, dt: number, t: number): void {
  const base = m.base;
  if (!m.prowlTo || Math.hypot(m.prowlTo.x - m.x, m.prowlTo.y - m.y) < 1.6 || t > m.prowlUntil) {
    m.prowlN++;
    const r = rand01(m.seed, m.prowlN);
    const alt = m.prowlN % 2 === 1;
    let q: Pt;
    if (m.kind === 'ogre') {
      const away = foe ? Math.sign(base.x - foe.x) || 1 : 1;
      if (r < 0.3) {
        q = { x: base.x + (alt ? 2 : -2), y: base.y + (alt ? 6 : -6) }; // side-step
      } else if (r < 0.62 && foe) {
        // a small arc round the foe at the same range
        const rad = Math.hypot(base.x - foe.x, (base.y - foe.y) / 0.7);
        const ang = Math.atan2((base.y - foe.y) / 0.7, base.x - foe.x) + (alt ? 0.38 : -0.38);
        q = { x: foe.x + Math.cos(ang) * rad, y: foe.y + Math.sin(ang) * rad * 0.7 };
      } else {
        q = { x: base.x + away * (alt ? 6 : -3), y: base.y + (r < 0.8 ? 1 : -1) }; // shuffle back / forth
      }
    } else if (m.kind === 'goblin') {
      q = { x: base.x + (alt ? 3 : -3), y: base.y + (r < 0.5 ? 1 : -1) };
    } else {
      q = { x: base.x + Math.cos(r * Math.PI * 2) * 3, y: base.y + Math.sin(r * Math.PI * 2) * 2 };
    }
    if (!isWalkable(world, q.x, q.y)) q = { ...base };
    m.prowlTo = q;
    m.prowlUntil = t + 2.5;
  }
  walkToward(m, m.prowlTo, PROWL_SPEED[m.kind] * dt, world);
  m.prowling = true;
}

/**
 * Syncs the roster to the heroes' error state and advances every monster's phase / position.
 * `siteFor` gives the failing file's building (the monster waits there) or null (it shadows its hero).
 */
export function updateMonsters(ms: Map<string, Monster>, heroes: Map<string, Hero>, world: World, dt: number, t: number, st: AmbientState, siteFor: (h: Hero) => Pt | null): void {
  preloadMonsters();
  for (const h of heroes.values()) {
    const err = h.removing || h.alpha <= 0 ? null : h.agent.lastError;
    const want = err ? kindForStreak(h.agent.errorStreak) : null;
    const m = ms.get(h.sessionId);
    if (err && want) {
      const site = siteFor(h);
      if (!m) {
        const side = site ? anchorSide(site, world) : pickSide(h, world, ms.values());
        // spawn a few steps off and walk in: the hero steps up to meet it halfway
        const at = site ?? nearestWalkable(world, { x: h.x + side * SPAWN_DIST, y: h.y + 1 });
        const gap = monsterGap(want);
        const standing = h.arrived && !h.moving;
        // the meeting spot (and the monster's stand point beside it) must be open ground: never the pond / a trunk
        let heroAt: Pt | null = site ? nearestWalkable(world, { x: site.x - side * (gap + ANCHOR_WALK), y: site.y }) : standing ? { x: h.x + side * ((SPAWN_DIST - gap) / 2), y: h.y } : null;
        if (heroAt && !site && (!isWalkable(world, heroAt.x, heroAt.y) || !isWalkable(world, heroAt.x + side * gap, heroAt.y + 1))) heroAt = null;
        const fresh: Monster = {
          sessionId: h.sessionId,
          kind: want,
          tool: err.tool,
          detail: err.detail,
          x: at.x,
          y: at.y,
          side,
          phase: 'spawn',
          phaseT: 0,
          bornAt: t,
          doomed: false,
          seed: hash32(h.sessionId) % 1000,
          tauntAt: t + 1.5 + Math.random() * 2,
          tauntUntil: 0,
          moving: false,
          flinchAt: -10,
          nextFlinchAt: t + 0.8,
          anchor: site,
          attackAt: -10,
          heroAt,
          homeKey: heroAt ? `${h.placeId}/${h.repoId ?? ''}` : null,
          origin: at,
          engaged: false,
          walkRef: { x: at.x, y: at.y },
          lastMovedAt: -10,
          flashAt: -10,
          base: { x: at.x, y: at.y },
          face: side === 1 ? 1 : -1,
          prowlTo: null,
          prowlUntil: 0,
          prowlN: 0,
          prowling: false,
          approaching: true,
          simulated: false,
          damage: 0,
          toughness: 0,
        };
        ms.set(h.sessionId, fresh);
        poof(st, monsterCentre(fresh), 8);
      } else {
        m.tool = err.tool;
        m.detail = err.detail;
        // the failing file moved to another building: pop over there
        if (monsterAlive(m) && (site?.x !== m.anchor?.x || site?.y !== m.anchor?.y)) {
          m.anchor = site;
          if (site) {
            poof(st, monsterCentre(m), 8);
            m.x = site.x;
            m.y = site.y;
            m.side = anchorSide(site, world);
            m.heroAt = nearestWalkable(world, { x: site.x - m.side * (monsterGap(m.kind) + ANCHOR_WALK), y: site.y });
            m.homeKey = null;
            poof(st, monsterCentre(m), 8);
          } else {
            m.heroAt = null;
          }
        }
        if (monsterAlive(m)) {
          m.doomed = false;
          if (m.kind !== want) {
            // the streak grew: swap in the bigger monster with a puff
            m.kind = want;
            m.phase = 'spawn';
            m.phaseT = 0;
            m.bornAt = t;
            poof(st, monsterCentre(m), 10);
          }
        }
      }
    } else if (m && monsterAlive(m)) {
      m.doomed = true;
    }
  }
  for (const m of ms.values()) {
    const h = m.simulated ? null : (heroes.get(m.sessionId) ?? null);
    if (!m.simulated && (!h || h.removing) && monsterAlive(m)) m.doomed = true;
    m.phaseT += dt;
    m.moving = false;
    if (h && monsterAlive(m)) {
      // walk to the meeting spot (heroAt + gap) while the hero is headed there; otherwise keep beside the hero
      const meet = m.heroAt && (m.anchor || Math.hypot(h.spot.x - m.heroAt.x, h.spot.y - m.heroAt.y) < 2) ? m.heroAt : null;
      if (!meet) {
        // a stray (no meeting spot) swaps sides if this one is in a wall / off the map
        const other: 1 | -1 = m.side === 1 ? -1 : 1;
        if (h.arrived && !h.moving && !sideFits(h, m.side, world, ms.values()) && sideFits(h, other, world, ms.values())) m.side = other;
      }
      const tg = nearestWalkable(world, meet ? { x: meet.x + m.side * monsterGap(m.kind), y: meet.y + 1 } : targetFor(h, m.side, m.kind));
      const dist = Math.hypot(tg.x - m.x, tg.y - m.y);
      const attacking = t < m.tauntUntil && t >= m.attackAt;
      m.prowling = false;
      m.face = h.x < m.x ? 1 : -1;
      if (attacking) {
        // planted for the wind-up, lunge and recovery
      } else if (dist > PROWL_ZONE) {
        m.approaching = true;
        m.prowlTo = null;
        walkToward(m, tg, (dist > 50 && !m.anchor ? CATCHUP_SPEED : WALK_SPEED) * dt, world);
      } else {
        m.approaching = false;
        m.base = tg;
        prowl(m, { x: h.x, y: h.y }, world, dt, t);
      }
      m.engaged = !h.moving && Math.hypot(h.x - m.x, h.y - m.y) < monsterGap(m.kind) + PROWL_ZONE;
    }
    switch (m.phase) {
      case 'spawn':
        if (m.phaseT >= SPAWN_DUR) {
          m.phase = 'idle';
          m.phaseT = 0;
        }
        break;
      case 'idle':
        if (m.doomed && t - m.bornAt >= MIN_LIFE) {
          m.phase = 'hit';
          m.phaseT = 0;
          emitSparkBurst(st, monsterCentre(m), '#ffffff', 6, 60);
        } else if (t >= m.tauntAt && t >= m.tauntUntil && !m.approaching && m.engaged) {
          // attack every 3–6 s while a hero is in reach (the eyeball lunges with a blink)
          m.attackAt = t;
          m.tauntUntil = t + ATTACK_DUR;
          m.tauntAt = t + 3 + Math.random() * 3;
        }
        break;
      case 'hit':
        if (m.phaseT >= HIT_DUR) {
          m.phase = 'dying';
          m.phaseT = 0;
          poof(st, monsterCentre(m), 10);
          if (m.kind === 'bug') emitSparkBurst(st, monsterCentre(m), '#d4493f', 5, 40);
        }
        break;
      case 'dying':
        // dust where the body lands
        if (fallsOver(m.kind) && m.phaseT >= FALL_DUR && m.phaseT - dt < FALL_DUR) poof(st, { x: m.x + m.side * bodyHeight(m.kind) * 0.6, y: m.y - 2 }, 8, '#b8a57a');
        if (m.phaseT >= dieDur(m)) ms.delete(m.sessionId);
        break;
    }
  }
}

// ── WAR practice monsters ──

/** Sword hits a practice monster takes (a hero's beats land ~1 hit/s: ~12–15 s alone, ~6–8 s with two). */
const PRACTICE_TOUGH_MIN = 12;
const PRACTICE_TOUGH_RANGE = 3;
/** How far a practice monster walks out from its spawn to meet the heroes. */
const PRACTICE_ROAM = 40;
const PRACTICE_RESPAWN = 1.4;
const PRACTICE_KINDS: MonsterKind[] = ['bug', 'goblin', 'ogre', 'goblin', 'bug', 'ogre'];
/** Practice monsters prefer open ground within this distance of home, so the fight starts quickly. */
const PRACTICE_REACH = 340;

export interface Practice {
  nextId: number;
  /** Times at which a replacement may appear. */
  respawnAt: number[];
  lastDeath: Pt | null;
}

export function createPractice(): Practice {
  return { nextId: 1, respawnAt: [], lastDeath: null };
}

export interface PracticeOpts {
  war: boolean;
  /** How many practice monsters should be on the field. */
  want: number;
  /** Open-ground candidates to spawn on. */
  spots: Pt[];
  /** Where the villagers come from (the plaza). */
  home: Pt;
  /** Monster id → feet of the heroes standing at it and swinging. */
  attackers: Map<string, Pt[]>;
  /** Monster id → feet of every hero posted to it (walking ones too): it walks out to meet them. */
  hunters: Map<string, Pt[]>;
  /** For walkability (practice monsters never walk into the pond). */
  world: World;
}

function killMonster(m: Monster, st: AmbientState): void {
  m.phase = 'hit';
  m.phaseT = 0;
  emitSparkBurst(st, monsterCentre(m), '#ffffff', 8, 70);
}

/** Open spot clear of the live monsters, leaning towards home; a replacement lands a short march from the last kill. */
function pickPracticeSpot(ms: Map<string, Monster>, pr: Practice, o: PracticeOpts): Pt | null {
  const busy: Pt[] = [...ms.values()].filter(monsterAlive).map((m) => ({ x: m.x, y: m.y }));
  let best: Pt | null = null;
  let bestScore = -Infinity;
  for (const c of o.spots) {
    const gap = busy.reduce((d, b) => Math.min(d, Math.hypot(b.x - c.x, b.y - c.y)), 320);
    const far = Math.max(0, Math.hypot(c.x - o.home.x, c.y - o.home.y) - PRACTICE_REACH);
    const death = pr.lastDeath ? Math.hypot(c.x - pr.lastDeath.x, c.y - pr.lastDeath.y) : null;
    const march = death === null ? 0 : death < 120 ? (120 - death) * 3 : Math.max(0, death - 260) * 0.8;
    const score = Math.min(gap, 200) - far * 1.2 - march + Math.random() * 40;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function spawnPractice(ms: Map<string, Monster>, pr: Practice, o: PracticeOpts, t: number, st: AmbientState): void {
  const at = pickPracticeSpot(ms, pr, o);
  if (!at) return;
  const n = pr.nextId++;
  const id = `sim:${n}`;
  const seed = hash32(id) % 1000;
  const m: Monster = {
    sessionId: id,
    kind: PRACTICE_KINDS[(n - 1) % PRACTICE_KINDS.length] ?? 'goblin', // plain rotation: the first three spawns show all three kinds
    tool: null,
    detail: null,
    x: at.x,
    y: at.y,
    side: seed % 2 === 0 ? 1 : -1,
    phase: 'spawn',
    phaseT: 0,
    bornAt: t,
    doomed: false,
    seed,
    tauntAt: t + 1 + Math.random() * 2,
    tauntUntil: 0,
    moving: false,
    flinchAt: -10,
    nextFlinchAt: t,
    anchor: null,
    attackAt: -10,
    heroAt: null,
    homeKey: null,
    origin: { x: at.x, y: at.y },
    engaged: false,
    walkRef: { x: at.x, y: at.y },
    lastMovedAt: -10,
    flashAt: -10,
    base: { x: at.x, y: at.y },
    face: seed % 2 === 0 ? -1 : 1,
    prowlTo: null,
    prowlUntil: 0,
    prowlN: 0,
    prowling: false,
    approaching: false,
    simulated: true,
    damage: 0,
    toughness: PRACTICE_TOUGH_MIN + Math.floor(Math.random() * (PRACTICE_TOUGH_RANGE + 1)),
  };
  ms.set(id, m);
  poof(st, monsterCentre(m), 10);
}

/** Keeps `want` practice monsters on the field during WAR: attacks wear them down, the fallen respawn elsewhere; WAR off kills them all. */
export function updatePractice(ms: Map<string, Monster>, pr: Practice, o: PracticeOpts, dt: number, t: number, st: AmbientState): void {
  const sims = [...ms.values()].filter((m) => m.simulated && monsterAlive(m));
  if (!o.war) {
    for (const m of sims) killMonster(m, st);
    pr.respawnAt = [];
    pr.lastDeath = null;
    return;
  }
  let alive = 0;
  for (const m of sims) {
    const foes = m.phase === 'idle' ? (o.attackers.get(m.sessionId) ?? []) : [];
    m.engaged = foes.length > 0;
    // walk out (within PRACTICE_ROAM of the spawn) toward the nearest hero marching at it, then hold
    const hunters = o.hunters.get(m.sessionId) ?? [];
    m.prowling = false;
    const swinging = t < m.tauntUntil && t >= m.attackAt;
    if (!m.engaged && hunters.length > 0 && m.phase === 'idle' && !swinging) {
      const near = hunters.reduce((a, b) => (Math.hypot(b.x - m.x, b.y - m.y) < Math.hypot(a.x - m.x, a.y - m.y) ? b : a));
      const d = Math.hypot(near.x - m.x, near.y - m.y);
      const roam = Math.hypot(near.x - m.origin.x, near.y - m.origin.y);
      m.face = near.x < m.x ? 1 : -1;
      const k = Math.min(1, PRACTICE_ROAM / Math.max(1, roam));
      const tg = { x: m.origin.x + (near.x - m.origin.x) * k, y: m.origin.y + (near.y - m.origin.y) * k };
      // walk out to meet them (never into the pond / trunks), else pace where it is
      if (d > 40 && isWalkable(o.world, tg.x, tg.y) && Math.hypot(tg.x - m.x, tg.y - m.y) > 1.5) {
        walkToward(m, tg, WALK_SPEED * dt, o.world);
        m.base = { x: m.x, y: m.y };
        m.prowlTo = null;
      } else {
        prowl(m, near, o.world, dt, t);
      }
    } else if (!m.engaged && m.phase === 'idle' && !swinging) {
      // nobody coming yet: pace round its spot (the ogre never just stands)
      prowl(m, null, o.world, dt, t);
    }
    if (m.engaged) {
      // face the nearest attacker and pace round the spot it stopped on; strike frames deal the damage (strikeMonster)
      const near = foes.reduce((a, b) => (Math.abs(b.x - m.x) < Math.abs(a.x - m.x) ? b : a));
      m.side = near.x < m.x ? 1 : -1;
      m.face = m.side;
      if (!swinging) prowl(m, near, o.world, dt, t);
      if (m.damage >= m.toughness) {
        killMonster(m, st);
        pr.lastDeath = { x: m.x, y: m.y };
        pr.respawnAt.push(t + PRACTICE_RESPAWN);
        continue;
      }
    }
    alive++;
  }
  // too many for the current draft: retire the ones nobody is fighting
  for (const m of sims) {
    if (alive <= o.want) break;
    if (monsterAlive(m) && !(o.attackers.get(m.sessionId)?.length)) {
      killMonster(m, st);
      alive--;
    }
  }
  // top up (staggered) and hatch replacements that are due
  while (alive + pr.respawnAt.length < o.want) pr.respawnAt.push(t + pr.respawnAt.length * 0.1);
  pr.respawnAt.sort((a, b) => a - b);
  while (pr.respawnAt.length > Math.max(0, o.want - alive)) pr.respawnAt.pop();
  while (pr.respawnAt.length > 0 && (pr.respawnAt[0] as number) <= t && alive < o.want) {
    pr.respawnAt.shift();
    spawnPractice(ms, pr, o, t, st);
    alive++;
  }
}

export interface DrawnMonster {
  top: number;
  bottom: number;
}

const easeOut = (k: number): number => 1 - (1 - k) * (1 - k);

/** Draws one monster at its feet point; returns the sprite's top / bottom for labels. */
export function drawMonster(ctx: CanvasRenderingContext2D, m: Monster, t: number, dt: number, st: AmbientState, hot: boolean): DrawnMonster {
  const dying = m.phase === 'dying';
  const fall = dying && fallsOver(m.kind);
  const k = dying ? Math.min(1, m.phaseT / dieDur(m)) : 0;
  const hitK = m.phase === 'hit' ? Math.min(1, m.phaseT / HIT_DUR) : 0;
  const flinchK = Math.min(1, (t - m.flashAt) / 0.2);
  // staggers away from its foe
  const knock = (m.phase === 'hit' ? Math.round(Math.sin(hitK * Math.PI) * 8) : flinchK < 1 ? Math.round(Math.sin(flinchK * Math.PI) * 2) : 0) * m.face;
  // walk row only while the feet really moved in the last ~100 ms
  if (Math.hypot(m.x - m.walkRef.x, m.y - m.walkRef.y) > 0.75) {
    m.walkRef = { x: m.x, y: m.y };
    m.lastMovedAt = t;
  }
  const stepping = t - m.lastMovedAt < 0.1;
  // attack: rear back through the wind-up (telegraph), lunge fast, hold the blow, recover
  const since = t - m.attackAt;
  const attacking = monsterAlive(m) && t < m.tauntUntil && since >= 0;
  let lunge = 0;
  if (attacking) {
    const reach = lungePx(m.kind);
    if (since < MONSTER_WINDUP) lunge = m.side * Math.round(2 * (since / MONSTER_WINDUP) ** 2);
    else if (since < MONSTER_WINDUP + LUNGE) lunge = -m.side * Math.round(reach * easeOut((since - MONSTER_WINDUP) / LUNGE));
    else if (since < MONSTER_WINDUP + LUNGE + LUNGE_HOLD) lunge = -m.side * reach;
    else lunge = -m.side * Math.round(reach * (1 - Math.min(1, (since - MONSTER_WINDUP - LUNGE - LUNGE_HOLD) / RECOVERY)));
  }
  const flash = (m.phase === 'hit' && m.phaseT < FLASH_DUR) || t - m.flashAt < FLASH_DUR;
  const scale = m.phase === 'spawn' ? 0.3 + 0.7 * easeOut(Math.min(1, m.phaseT / SPAWN_DUR)) : 1;
  const fade0 = fall ? 0.55 : 0.35;
  const alpha = dying ? 1 - Math.max(0, (k - fade0) / (1 - fade0)) : 1;
  const isBug = m.kind === 'bug';
  const hover = isBug ? BUG_HOVER + Math.sin(t * 3 + m.seed) * 2 - (dying ? k * k * (BUG_HOVER + 2) : 0) : 0;
  const x = m.x + knock + lunge;
  const y = m.y - Math.round(hover);

  // shadow (the bug's shrinks as it hovers)
  const sh = isBug ? 4 : Math.max(6, Math.round(bodyHeight(m.kind) * 0.32));
  drawPixelEllipse(ctx, Math.round(m.x), Math.round(m.y), sh, 2, `rgba(20,16,8,${(0.28 * alpha).toFixed(3)})`);
  if (hot && !dying) drawPixelRing(ctx, m.x, m.y - 1, sh + 5, 'rgba(248,113,113,0.9)');

  ctx.save();
  ctx.globalAlpha *= alpha;
  if (scale !== 1) {
    ctx.translate(x, m.y);
    ctx.scale(scale, scale);
    ctx.translate(-x, -m.y);
  }
  const faceLeft = m.face === 1; // its foe is to its left → look left
  if (fall) {
    // tip over backwards (away from the hero) around the feet
    const fk = Math.min(1, m.phaseT / FALL_DUR);
    ctx.translate(x, y);
    ctx.rotate(fk * fk * (Math.PI / 2) * (faceLeft ? 1 : -1));
    ctx.translate(-x, -y);
  }
  let anim: MonsterAnim = 'idle';
  let at = t + m.seed;
  let frameOverride: number | null = null;
  if (fall) {
    frameOverride = 0;
  } else if (dying) {
    if (isBug) {
      anim = 'blink';
      frameOverride = 2 + Math.min(2, Math.floor(k * 3.5)); // eye closes as it drops
    } else {
      anim = 'death';
      at = m.phaseT;
    }
  } else if (attacking) {
    // hold the sheet's wind-up pose for the whole telegraph, then play the blow
    anim = isBug ? 'blink' : 'taunt';
    at = since < MONSTER_WINDUP ? (since / MONSTER_WINDUP) * (SHEET_WINDUP - 0.01) : SHEET_WINDUP + (since - MONSTER_WINDUP);
  } else if (stepping && monsterHasAnim(m.kind, 'move') && !(m.kind !== 'ogre' && m.prowling)) {
    // the goblin's run row is a leaping sprint: its small prowl shuffle keeps the idle row (no hopping in place)
    // walking (and the ogre's prowl) uses the walk row; the eyeball's gentle drift keeps its hover row
    anim = 'move';
    at = t;
  }
  const drawn = monsterSheetReady(m.kind) ? drawMonsterFrame(ctx, m.kind, anim, at, x, y, faceLeft, flash, frameOverride) : null;
  const box = drawn ?? drawFallbackMonster(ctx, m.kind, x, y, faceLeft, flash, t);
  ctx.restore();

  if (dying && Math.random() < dt * 14) {
    spawn(st, { x: m.x + (Math.random() - 0.5) * 16, y: y - 6 - Math.random() * 10, vx: (Math.random() - 0.5) * 10, vy: -16, age: 0, ttl: 0.6, size: 2, color: isBug ? '#f4c2c2' : '#b8c0da', kind: 'mote' });
  }
  if (monsterAlive(m) || m.phase === 'hit') return { top: drawHpBar(ctx, m, box.top, t), bottom: m.y };
  return { top: box.top, bottom: m.y };
}

/**
 * HP over the head; returns the bar's top. Practice: one pixel per hit point, always the CURRENT value,
 * with only the point just lost blinking white for HIT_BLINK. Real error monsters: full and locked
 * (padlock) since only clearing the error kills them; a hit just flashes the frame.
 */
const HIT_BLINK = 0.12;
function drawHpBar(ctx: CanvasRenderingContext2D, m: Monster, top: number, t: number): number {
  const hit = t - m.flinchAt < HIT_BLINK;
  const w = m.simulated ? Math.max(1, m.toughness) : HP_LOCKED_W;
  // a real monster's bar leans away from its hero so the hero's error bubble never covers the padlock
  const bx = Math.round(m.x - w / 2 + (m.simulated ? 0 : m.side * 12));
  const by = Math.round(top) - 5;
  ctx.fillStyle = hit && !m.simulated ? '#ffffff' : 'rgba(20,16,8,0.85)';
  ctx.fillRect(bx - 1, by - 1, w + 2, 4);
  if (m.simulated) {
    const left = Math.max(0, m.toughness - m.damage);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(bx, by, left, 2);
    ctx.fillStyle = '#4a2a24';
    ctx.fillRect(bx + left, by, w - left, 2);
    if (hit && m.damage > 0 && left < w) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx + left, by, 1, 2);
    }
  } else {
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(bx, by, w, 2);
    // padlock at the bar's far end from the hero: shackle + body
    const lx = m.side === 1 ? bx + w + 3 : bx - 6;
    ctx.fillStyle = 'rgba(20,16,8,0.85)';
    ctx.fillRect(lx - 1, by - 3, 5, 7);
    ctx.fillStyle = '#c9cfd8';
    ctx.fillRect(lx, by - 2, 3, 1);
    ctx.fillRect(lx, by - 1, 1, 1);
    ctx.fillRect(lx + 2, by - 1, 1, 1);
    ctx.fillStyle = '#e0b040';
    ctx.fillRect(lx, by, 3, 3);
  }
  return by - (m.simulated ? 1 : 3);
}
const HP_LOCKED_W = 16;

/** Programmatic stand-ins drawn until a sheet arrives (or if it failed). */
function drawFallbackMonster(ctx: CanvasRenderingContext2D, kind: MonsterKind, x: number, y: number, faceLeft: boolean, flash: boolean, t: number): DrawnMonster {
  const cx = Math.round(x);
  const fy = Math.round(y);
  const f = faceLeft ? -1 : 1;
  const col = (c: string): string => (flash ? '#ffffff' : c);
  if (kind === 'bug') {
    const cy = fy - 8;
    drawPixelDisc(ctx, cx, cy, 8, col('#2b2520'));
    drawPixelDisc(ctx, cx, cy, 7, col('#f6f0f0'));
    ctx.fillStyle = col('#d4493f');
    ctx.fillRect(cx - 5, cy - 2, 2, 1);
    ctx.fillRect(cx + 3, cy + 2, 2, 1);
    ctx.fillRect(cx - f * 7, cy + 4, 4, 2);
    ctx.fillRect(cx - f * 9, cy + 6, 3, 2);
    drawPixelDisc(ctx, cx + f, cy, 3, col('#4f8a4a'));
    drawPixelDisc(ctx, cx + f, cy, 1, col('#17120f'));
    return { top: cy - 8, bottom: fy };
  }
  const big = kind === 'ogre';
  const h = big ? 26 : 16;
  const w = big ? 12 : 8;
  ctx.fillStyle = col('#17120f');
  ctx.fillRect(cx - w / 2 - 1, fy - h - 1, w + 2, h + 2);
  ctx.fillStyle = col(big ? '#4f8a4a' : '#6ea84a');
  ctx.fillRect(cx - w / 2, fy - h, w, h);
  ctx.fillStyle = col(big ? '#5d3d22' : '#d4493f');
  ctx.fillRect(cx - w / 2, fy - Math.round(h * 0.45), w, Math.round(h * 0.25));
  ctx.fillStyle = col('#17120f');
  ctx.fillRect(cx + f * 2, fy - h + 4, 1, 1);
  ctx.fillRect(cx + f * 4 - (f < 0 ? 1 : 0), fy - h + 4, 1, 1);
  // club / knife in the leading hand
  ctx.fillStyle = col(big ? '#8a5a33' : '#dfe6ee');
  const swing = Math.sin(t * 6) > 0 ? -2 : 0;
  if (big) ctx.fillRect(cx + f * (w / 2 + 1), fy - h + 2 + swing, 3, 14);
  else ctx.fillRect(cx + f * (w / 2 + 1), fy - 8 + swing, 1, 5);
  return { top: fy - h - 1, bottom: fy };
}
