// "Living world" extras layered on top of ambient.ts: busy-place glow + sparks,
// your-turn gold beacons, Simone volcano glow + embers, grass-bound fireflies,
// wind, and water shimmer. Everything is pooled (typed arrays, no per-frame
// allocation in the hot loops) and honours `reduced` (static / no motion).

import { WORLD_H, WORLD_W } from './constants';
import type { Rect } from './pixel';
import type { PlaceGeom } from './places';
import type { World } from './terrain';

// ── particle pool ────────────────────────────────────────────────────────────
const POOL = 200;
const K_EMBER = 0; // rising orange/yellow, shrinks
const K_SPARK = 1; // busy-place spark, rises and twinkles
const K_SMOKE = 2; // volcano ash puff

interface Activity {
  /** eased 0..1 busy / your-turn levels */
  busy: number;
  turn: number;
  busyTarget: number;
  turnTarget: number;
  /** fractional spark emission carry */
  acc: number;
}

export interface LifeState {
  reduced: boolean;
  px: Float32Array;
  py: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  age: Float32Array;
  ttl: Float32Array;
  kind: Uint8Array;
  alive: Uint8Array;
  cursor: number;
  activity: Map<string, Activity>;
  emberAcc: number;
  /** firefly anchors sampled from grass tufts (x,y pairs), rebuilt when the world changes */
  flyXY: Float32Array;
  flyN: number;
  flyKey: object | null;
  glowSprite: HTMLCanvasElement | null;
  sinceSummary: number;
}

export function createLife(reduced: boolean): LifeState {
  return {
    reduced,
    px: new Float32Array(POOL),
    py: new Float32Array(POOL),
    vx: new Float32Array(POOL),
    vy: new Float32Array(POOL),
    age: new Float32Array(POOL),
    ttl: new Float32Array(POOL),
    kind: new Uint8Array(POOL),
    alive: new Uint8Array(POOL),
    cursor: 0,
    activity: new Map(),
    emberAcc: 0,
    flyXY: new Float32Array(2 * 40),
    flyN: 0,
    flyKey: null,
    glowSprite: null,
    sinceSummary: 99,
  };
}

/** Slow, gusting wind in px/s used by smoke and ash (shared so everything leans the same way). */
export function windAt(t: number): number {
  return 4 + Math.sin(t * 0.23) * 3 + Math.sin(t * 0.71 + 1.3) * 1.5;
}

function emit(s: LifeState, kind: number, x: number, y: number, vx: number, vy: number, ttl: number): void {
  // ring cursor: overwrite the oldest slot when full (never allocates)
  let i = s.cursor;
  for (let n = 0; n < POOL; n++) {
    if (!s.alive[i]) break;
    i = (i + 1) % POOL;
  }
  s.cursor = (i + 1) % POOL;
  s.alive[i] = 1;
  s.kind[i] = kind;
  s.px[i] = x;
  s.py[i] = y;
  s.vx[i] = vx;
  s.vy[i] = vy;
  s.age[i] = 0;
  s.ttl[i] = ttl;
}

// ── activity summary (called at ~2 Hz from Village.tsx) ──────────────────────

/** Replace the per-place targets. `busy` / `turn` map placeId → hero count. */
export function setActivity(s: LifeState, busy: ReadonlyMap<string, number>, turn: ReadonlyMap<string, number>): void {
  for (const a of s.activity.values()) {
    a.busyTarget = 0;
    a.turnTarget = 0;
  }
  const touch = (id: string): Activity => {
    let a = s.activity.get(id);
    if (!a) {
      a = { busy: 0, turn: 0, busyTarget: 0, turnTarget: 0, acc: 0 };
      s.activity.set(id, a);
    }
    return a;
  };
  for (const [id, n] of busy) if (n > 0) touch(id).busyTarget = Math.min(1, 0.65 + n * 0.2);
  for (const [id, n] of turn) if (n > 0) touch(id).turnTarget = 1;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function glowSprite(s: LifeState): HTMLCanvasElement | null {
  if (s.glowSprite) return s.glowSprite;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  if (!g) return null;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  s.glowSprite = cv;
  return cv;
}

/** Tinted glow blob: draws the white sprite then tints it by drawing it through a coloured composite is too costly, so
 *  glow colours are baked into tiny per-colour sprites on first use. */
const TINTS = new Map<string, HTMLCanvasElement>();
function tinted(s: LifeState, color: string): HTMLCanvasElement | null {
  const hit = TINTS.get(color);
  if (hit) return hit;
  const base = glowSprite(s);
  if (!base) return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.drawImage(base, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 128);
  TINTS.set(color, cv);
  return cv;
}

function blob(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, cx: number, cy: number, rx: number, ry: number, alpha: number): void {
  if (alpha <= 0.002) return;
  ctx.globalAlpha = alpha > 1 ? 1 : alpha;
  ctx.drawImage(sprite, cx - rx, cy - ry, rx * 2, ry * 2);
}

function lairOf(world: World): PlaceGeom | null {
  for (const g of world.places) if (g.kind === 'lair') return g;
  return null;
}

function rebuildFireflies(s: LifeState, world: World): void {
  s.flyKey = world.tufts;
  s.flyN = 0;
  const tufts = world.tufts;
  if (tufts.length === 0) return;
  const stride = Math.max(1, Math.floor(tufts.length / 40));
  for (let i = 0; i < tufts.length && s.flyN < 40; i += stride) {
    const tf = tufts[i];
    if (!tf) continue;
    let blocked = false;
    for (const g of world.places) {
      const r = g.rect;
      if (tf.x > r.x - 8 && tf.x < r.x + r.w + 8 && tf.y > r.y - 8 && tf.y < r.y + r.h + 8) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    s.flyXY[s.flyN * 2] = tf.x;
    s.flyXY[s.flyN * 2 + 1] = tf.y;
    s.flyN++;
  }
}

function anchorsOf(g: PlaceGeom): Rect[] {
  if (g.buildings.length > 0) return g.buildings.map((b) => b.rect);
  return [g.rect];
}

// ── update ───────────────────────────────────────────────────────────────────

export function updateLife(s: LifeState, world: World, dt: number, t: number, night: number): void {
  // ease activity levels
  for (const [id, a] of s.activity) {
    const k = Math.min(1, dt * 2.5);
    a.busy += (a.busyTarget - a.busy) * k;
    a.turn += (a.turnTarget - a.turn) * k;
    if (a.busyTarget === 0 && a.turnTarget === 0 && a.busy < 0.01 && a.turn < 0.01) {
      s.activity.delete(id);
      continue;
    }
    if (s.reduced || a.busy < 0.05) continue;
    // sparks rising off busy buildings (~5/s per place at full strength)
    const g = world.byId.get(id);
    if (!g) continue;
    a.acc += dt * 5 * a.busy;
    while (a.acc >= 1) {
      a.acc -= 1;
      const anchors = anchorsOf(g);
      const r = anchors[Math.floor(Math.random() * anchors.length)] ?? g.rect;
      emit(s, K_SPARK, r.x + Math.random() * r.w, r.y + r.h * 0.2 + Math.random() * 6, (Math.random() - 0.5) * 8 + windAt(t) * 0.3, -14 - Math.random() * 12, 1.1 + Math.random() * 0.7);
    }
  }

  if (s.reduced) return;

  // volcano: embers off the crater + lava seam, ash puffs; more at night
  const lair = lairOf(world);
  if (lair) {
    const { x, y, w } = lair.rect;
    const cx = x + w / 2;
    const rate = 6 + 9 * night;
    s.emberAcc += dt * rate;
    while (s.emberAcc >= 1) {
      s.emberAcc -= 1;
      if (Math.random() < 0.55) {
        // crater
        emit(s, K_EMBER, cx + (Math.random() - 0.5) * 8, y + 12, (Math.random() - 0.5) * 14 + windAt(t) * 0.8, -22 - Math.random() * 22, 1.6 + Math.random() * 1.2);
      } else {
        // lava seam (matches the seam drawn in places.ts: from cx+40, y+98 down-right)
        const k = Math.random() * 20;
        emit(s, K_EMBER, cx + 40 + k * 2, y + 98 + k * 3, (Math.random() - 0.3) * 10, -12 - Math.random() * 14, 1.0 + Math.random() * 0.8);
      }
      if (Math.random() < 0.18) emit(s, K_SMOKE, cx + (Math.random() - 0.5) * 6, y + 10, windAt(t) * 1.1, -10 - Math.random() * 5, 3.4);
    }
  }

  // advance pool
  for (let i = 0; i < POOL; i++) {
    if (!s.alive[i]) continue;
    const age = (s.age[i] as number) + dt;
    if (age >= (s.ttl[i] as number)) {
      s.alive[i] = 0;
      continue;
    }
    s.age[i] = age;
    s.px[i] = (s.px[i] as number) + (s.vx[i] as number) * dt;
    s.py[i] = (s.py[i] as number) + (s.vy[i] as number) * dt;
    const kind = s.kind[i];
    if (kind === K_SMOKE) s.vx[i] = (s.vx[i] as number) + (windAt(t) * 1.2 - (s.vx[i] as number)) * dt * 0.6;
    else s.vx[i] = (s.vx[i] as number) + Math.sin(t * 3 + i) * 10 * dt;
  }

  if (night > 0.1 && s.flyKey !== world.tufts) rebuildFireflies(s, world);
}

// ── draw: ground (under night tint) ──────────────────────────────────────────

/** River shimmer: the static glints twinkle in turn and a few pale streaks slide downstream along the centreline. */
export function drawLifeGround(ctx: CanvasRenderingContext2D, s: LifeState, world: World, t: number): void {
  const water = world.water;
  if (!water) return;
  const f = s.reduced ? 0 : t;
  ctx.fillStyle = '#e6f6ff';
  const shine = water.shine;
  for (let i = 0; i < shine.length; i++) {
    const p = shine[i];
    if (!p) continue;
    const v = Math.sin(f * 2.1 + i * 1.7);
    if (v < 0.25) continue;
    ctx.globalAlpha = (v - 0.25) * 0.9;
    ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y), 3, 1);
  }
  // downstream streaks: positions are a pure function of time, so nothing is stored
  const path = water.path;
  const n = path.length;
  if (n > 4 && !s.reduced) {
    const streaks = Math.min(36, Math.floor(n / 6));
    for (let k = 0; k < streaks; k++) {
      const u = (k / streaks + t * 0.012) % 1;
      const idx = Math.min(n - 2, Math.floor(u * (n - 1)));
      const p = path[idx];
      const hw = water.halfW[idx] ?? 6;
      if (!p) continue;
      const side = Math.sin(k * 12.9898) * 0.6;
      const x = Math.round(p.x + side * hw);
      const y = Math.round(p.y);
      if (water.depth[y * WORLD_W + x] === undefined || (water.depth[y * WORLD_W + x] as number) < 3) continue;
      if (water.deck[y * WORLD_W + x]) continue;
      ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t * 2 + k);
      ctx.fillRect(x, y, 4, 1);
    }
  }
  ctx.globalAlpha = 1;
}

// ── draw: lights (over night tint, additive) ─────────────────────────────────

export function drawLifeLights(ctx: CanvasRenderingContext2D, s: LifeState, world: World, t: number, night: number): void {
  const warm = tinted(s, '#ffb25a');
  const lava = tinted(s, '#ff6a1f');
  const gold = tinted(s, '#ffd45e');
  if (!warm || !lava || !gold) return;
  const f = s.reduced ? 0 : t;
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = 'lighter';

  // volcano glow: crater + lava seam, pulsing, stronger at night
  const lair = lairOf(world);
  if (lair) {
    const { x, y, w } = lair.rect;
    const cx = x + w / 2;
    const pulse = 0.5 + 0.5 * Math.sin(f * 1.7) * 0.6 + 0.25 * Math.sin(f * 4.1 + 1);
    const base = 0.22 + 0.4 * night;
    blob(ctx, lava, cx, y + 14, 34 + pulse * 6, 22 + pulse * 4, base * (0.7 + pulse * 0.6));
    for (let k = 0; k < 4; k++) {
      const sx = cx + 44 + k * 13;
      const sy = y + 104 + k * 20;
      blob(ctx, lava, sx, sy, 22, 16, base * (0.55 + 0.4 * Math.sin(f * 2.3 + k * 1.4)));
    }
  }

  // static lava pools beside the lairs breathe
  for (let i = 0; i < world.lava.length; i++) {
    const p = world.lava[i];
    if (!p) continue;
    const pulse = 0.5 + 0.5 * Math.sin(f * 1.3 + i * 2.1);
    blob(ctx, lava, p.x, p.y, p.rx * 1.8, p.ry * 2.2, (0.18 + 0.3 * night) * (0.6 + 0.5 * pulse));
  }

  // busy places: soft pulsing warm aura on each building (or the plot)
  for (const [id, a] of s.activity) {
    const g = world.byId.get(id);
    if (!g) continue;
    if (a.busy > 0.02) {
      const pulse = 0.5 + 0.5 * Math.sin(f * 2.4 + g.rect.x * 0.01);
      const alpha = a.busy * (0.2 + 0.16 * pulse) * (1 + 0.8 * night);
      for (const r of anchorsOf(g)) {
        const rad = Math.max(r.w, r.h) * (0.75 + 0.08 * pulse);
        blob(ctx, warm, r.x + r.w / 2, r.y + r.h * 0.6, rad * 1.1, rad * 0.8, alpha);
      }
    }
    if (a.turn > 0.02) {
      const pulse = 0.5 + 0.5 * Math.sin(f * 1.8 + g.rect.y * 0.02);
      const cx = g.rect.x + g.rect.w / 2;
      blob(ctx, gold, cx, g.rect.y + 4, 22 + pulse * 4, 22 + pulse * 4, a.turn * (0.3 + 0.25 * pulse) * (1 + 0.5 * night));
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = smooth;

  // pulsing ring on the ground under busy places (thin ellipse outline expanding + fading)
  if (!s.reduced) {
    ctx.lineWidth = 1;
    for (const [id, a] of s.activity) {
      if (a.busy < 0.05) continue;
      const g = world.byId.get(id);
      if (!g) continue;
      const ph = (t * 0.55 + g.rect.x * 0.003) % 1;
      const r = g.rect;
      ctx.strokeStyle = `rgba(255,196,110,${(a.busy * 0.55 * (1 - ph)).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h - 8, r.w * (0.3 + 0.2 * ph), r.h * (0.1 + 0.07 * ph), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ── draw: front (after heroes) ───────────────────────────────────────────────

export function drawLifeFront(ctx: CanvasRenderingContext2D, s: LifeState, world: World, t: number, night: number): void {
  const f = s.reduced ? 0 : t;

  // pooled particles
  if (!s.reduced) {
    for (let i = 0; i < POOL; i++) {
      if (!s.alive[i]) continue;
      const k = (s.age[i] as number) / (s.ttl[i] as number);
      const kind = s.kind[i];
      const x = Math.round(s.px[i] as number);
      const y = Math.round(s.py[i] as number);
      if (kind === K_SMOKE) {
        ctx.globalAlpha = 0.35 * (1 - k);
        ctx.fillStyle = '#6a6670';
        const sz = 2 + Math.round(k * 5);
        ctx.fillRect(x - (sz >> 1), y - (sz >> 1), sz, sz);
      } else if (kind === K_EMBER) {
        ctx.globalAlpha = 1 - k * k;
        ctx.fillStyle = k < 0.4 ? '#ffd166' : k < 0.75 ? '#ff8c3b' : '#d2491f';
        ctx.fillRect(x, y, k < 0.6 ? 2 : 1, k < 0.6 ? 2 : 1);
      } else {
        ctx.globalAlpha = (1 - k) * (0.6 + 0.4 * Math.sin(t * 20 + i));
        ctx.fillStyle = k < 0.5 ? '#fff1b0' : '#ffb347';
        ctx.fillRect(x, y, 1, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // your-turn beacon: a gold pennant on a pole above the place + a tiny bobbing gem
  for (const [id, a] of s.activity) {
    if (a.turn < 0.05) continue;
    const g = world.byId.get(id);
    if (!g) continue;
    const bx = Math.round(g.rect.x + g.rect.w / 2);
    const by = g.rect.y - 8;
    const bob = Math.round(Math.sin(f * 2.2 + bx * 0.01) * 1.5);
    ctx.globalAlpha = a.turn;
    ctx.fillStyle = '#3a2d1f';
    ctx.fillRect(bx, by - 16 + bob, 1, 18);
    for (let k = 0; k < 8; k++) {
      const wave = Math.round(Math.sin(f * 5 + k * 0.8) * 1);
      ctx.fillStyle = k % 3 === 2 ? '#fff0b8' : '#f2c14e';
      ctx.fillRect(bx + 1 + k, by - 16 + bob + wave + (k > 5 ? 1 : 0), 1, 6 - (k > 5 ? 2 : 0));
    }
    ctx.fillStyle = '#fff6cf';
    ctx.fillRect(bx - 1, by - 18 + bob, 3, 3);
    ctx.globalAlpha = 1;
  }

  // fireflies in the grass at night (anchored to tufts away from buildings)
  if (!s.reduced && night > 0.2 && s.flyN > 0) {
    for (let i = 0; i < s.flyN; i++) {
      const ph = i * 2.399;
      const x = (s.flyXY[i * 2] as number) + Math.sin(t * 0.5 + ph) * 14;
      const y = (s.flyXY[i * 2 + 1] as number) - 6 + Math.cos(t * 0.37 + ph * 1.3) * 8;
      const blink = Math.sin(t * 1.8 + ph * 3);
      if (blink < 0.15) continue;
      const a = (blink - 0.15) * night;
      ctx.fillStyle = `rgba(214,255,120,${(a * 0.18).toFixed(3)})`;
      ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 5, 5);
      ctx.fillStyle = `rgba(236,255,160,${Math.min(1, a).toFixed(3)})`;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }
  void WORLD_W;
  void WORLD_H;
}

// ── hero → place summary ─────────────────────────────────────────────────────

interface HeroLike {
  placeId: string;
  status: string;
  removing: boolean;
  isSquire: boolean;
  agent: { alive: boolean; ccStatus: string | null; status: string };
}

const busyScratch = new Map<string, number>();
const turnScratch = new Map<string, number>();

/**
 * Busy = a hero working (running / thinking / delegating) at a real place, using the place the hero is drawn at
 * (hero.placeId, itself from resolveAgentPlace). Your-turn = alive and `done` / cc idle, resolved through
 * `resolve(hero)` (resolveAgentPlace) since those heroes rest at the tavern; unresolvable ones are skipped.
 * Cheap enough for ~2 Hz; Village.tsx throttles the call.
 */
export function summarizeHeroes<H extends HeroLike>(s: LifeState, heroes: Iterable<H>, resolve: (h: H) => string | null): void {
  busyScratch.clear();
  turnScratch.clear();
  for (const h of heroes) {
    if (h.removing || h.isSquire) continue;
    const working = h.status === 'running' || h.status === 'thinking' || h.status === 'delegating';
    if (working && h.placeId !== 'tavern' && h.placeId !== 'war') busyScratch.set(h.placeId, (busyScratch.get(h.placeId) ?? 0) + 1);
    const a = h.agent;
    if (a.alive && (a.status === 'done' || a.ccStatus === 'idle')) {
      const id = resolve(h);
      if (id) turnScratch.set(id, (turnScratch.get(id) ?? 0) + 1);
    }
  }
  setActivity(s, busyScratch, turnScratch);
}
