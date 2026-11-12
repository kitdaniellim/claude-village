// Ambient life drawn on top of the static world every frame: chimney smoke,
// torch flames, window flicker, birds, fireflies, bats, grass sway, pond
// shimmer, wall flags, windmill blades, campfires. All cheap pixel rects.

import { BAT_FRAMES, BIRD_FRAMES } from './sprites';
import { WORLD_H, WORLD_W } from './constants';
import { drawMatrix, mulberry32 } from './pixel';
import type { Pt } from './pixel';
import type { World } from './terrain';
import { createLife, drawLifeFront, drawLifeGround, drawLifeLights, updateLife, windAt } from './ambientLife';
import type { LifeState } from './ambientLife';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  ttl: number;
  size: number;
  color: string;
  /** smoke grows + fades; spark/flame shrink; mote drifts */
  kind: 'smoke' | 'spark' | 'flame' | 'mote' | 'puff' | 'sparkle';
  grow?: number;
}

interface Bird {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
}

interface Firefly {
  x: number;
  y: number;
  phase: number;
  speed: number;
}

export interface AmbientState {
  particles: Particle[];
  birds: Bird[];
  nextBirdAt: number;
  fireflies: Firefly[];
  smokeAcc: number;
  reduced: boolean;
  /** living-world extras (ambientLife.ts): busy glow, beacons, volcano, fireflies, water */
  life: LifeState;
}

export function createAmbient(reduced: boolean): AmbientState {
  const rng = mulberry32(0xf1ef1e);
  const fireflies: Firefly[] = [];
  for (let i = 0; i < 28; i++) {
    fireflies.push({ x: rng() * WORLD_W, y: rng() * WORLD_H, phase: rng() * Math.PI * 2, speed: 0.4 + rng() * 0.8 });
  }
  return { particles: [], birds: [], nextBirdAt: 4, fireflies, smokeAcc: 0, reduced, life: createLife(reduced) };
}

const BIRD_PALETTE = { b: '#2b2a33' };
const BAT_PALETTE = { k: '#1d1623' };

export function spawn(st: AmbientState, p: Particle): void {
  if (st.particles.length < 600) st.particles.push(p);
}

/** Advance particles, birds and timed emitters. */
export function updateAmbient(st: AmbientState, world: World, dt: number, t: number, night: number): void {
  // particles
  const keep: Particle[] = [];
  for (const p of st.particles) {
    p.age += dt;
    if (p.age >= p.ttl) continue;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === 'smoke') {
      p.vx += Math.sin(t * 1.7 + p.y * 0.05) * 6 * dt;
      p.vy *= 1 - 0.4 * dt;
    } else if (p.kind === 'spark' || p.kind === 'sparkle') {
      p.vy += 90 * dt;
    } else if (p.kind === 'flame') {
      p.vy -= 30 * dt;
    }
    keep.push(p);
  }
  st.particles = keep;

  // chimney smoke (~2.5 puffs / s per chimney)
  st.smokeAcc += dt;
  if (st.smokeAcc > 0.4) {
    st.smokeAcc = 0;
    for (const g of world.places) {
      for (const c of g.chimneys) {
        spawn(st, { x: c.x + 1, y: c.y, vx: windAt(t) * 0.8 + Math.random() * 3, vy: -11 - Math.random() * 5, age: 0, ttl: 3.2, size: 2, color: '#d9d4cc', kind: 'smoke', grow: 2.2 });
      }
    }
  }

  updateLife(st.life, world, dt, t, night);
  if (st.reduced) return;

  // birds: a small V crossing the sky every 9–16 s
  if (t > st.nextBirdAt) {
    st.nextBirdAt = t + 9 + Math.random() * 7;
    const ltr = Math.random() < 0.5;
    const y = 30 + Math.random() * (WORLD_H * 0.5);
    const vx = (ltr ? 1 : -1) * (48 + Math.random() * 20);
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      st.birds.push({ x: ltr ? -20 - i * 12 : WORLD_W + 20 + i * 12, y: y + Math.abs(i - 1) * 7, vx, vy: -3 + Math.random() * 6, phase: Math.random() * 6 });
    }
  }
  st.birds = st.birds.filter((b) => b.x > -60 && b.x < WORLD_W + 60);
  for (const b of st.birds) {
    b.x += b.vx * dt;
    b.y += b.vy * dt + Math.sin(t * 2 + b.phase) * 4 * dt;
  }
  void night;
}

/**
 * Layers behind the heroes. 'ground' (sway, pond, flags, windmill) is drawn
 * under the night tint; 'lights' (torches, fires, lit windows) over it.
 */
export function drawAmbientBack(ctx: CanvasRenderingContext2D, st: AmbientState, world: World, t: number, night: number, pass: 'ground' | 'lights'): void {
  if (pass === 'lights') {
    drawLights(ctx, st, world, t, night);
    drawLifeLights(ctx, st.life, world, t, night);
    return;
  }
  // grass sway: a blade that leans with a slow wave
  if (!st.reduced) {
    for (const tf of world.tufts) {
      const lean = Math.round(Math.sin(t * 1.6 + tf.x * 0.05 + tf.y * 0.03) * 1.5);
      ctx.fillStyle = '#67a03b';
      ctx.fillRect(tf.x, tf.y - 1, 1, 3);
      ctx.fillRect(tf.x + 2, tf.y, 1, 2);
      ctx.fillStyle = '#a8d472';
      ctx.fillRect(tf.x + lean, tf.y - 3, 1, 2);
      ctx.fillRect(tf.x + 2 + lean, tf.y - 2, 1, 2);
    }
  }
  // pond shimmer
  const pond = world.pond;
  if (pond) {
    for (let k = 0; k < 6; k++) {
      const a = t * 0.6 + k * 1.05;
      const px = Math.round(pond.x + Math.cos(a) * (pond.rx - 9) * 0.8);
      const py = Math.round(pond.y + Math.sin(a * 1.3) * (pond.ry - 6) * 0.8);
      const on = Math.sin(t * 3 + k) > 0.2;
      ctx.fillStyle = on ? '#c9e6f4' : '#85b8dd';
      ctx.fillRect(px, py, 3, 1);
    }
  }
  drawLifeGround(ctx, st.life, world, t);
  // lit-window sprite variants fade in under the night tint
  if (night > 0.03) {
    ctx.globalAlpha = night;
    for (const g of world.places) {
      for (const b of g.buildings) if (b.lit) ctx.drawImage(b.lit.img, b.lit.x, b.lit.y);
    }
    ctx.globalAlpha = 1;
  }
  for (const g of world.places) {
    if (g.windmill) {
      const w = g.windmill;
      const ang = t * 0.9;
      ctx.fillStyle = '#5d3d22';
      for (let b = 0; b < 4; b++) {
        const a = ang + (b * Math.PI) / 2;
        for (let k = 2; k < 22; k++) {
          ctx.fillRect(Math.round(w.x + Math.cos(a) * k), Math.round(w.y + Math.sin(a) * k), 2, 2);
          if (k > 8 && k % 2 === 0) {
            ctx.fillStyle = '#e8d6ad';
            ctx.fillRect(Math.round(w.x + Math.cos(a) * k - Math.sin(a) * 3), Math.round(w.y + Math.sin(a) * k + Math.cos(a) * 3), 2, 2);
            ctx.fillStyle = '#5d3d22';
          }
        }
      }
      ctx.fillStyle = '#3a2d1f';
      ctx.fillRect(w.x - 1, w.y - 1, 3, 3);
    }
    // wall flags (cloth waves)
    for (const f of g.flags) {
      ctx.fillStyle = '#3a2d1f';
      ctx.fillRect(f.x, f.y - 12, 1, 14);
      const cloth = g.id === 'habits' ? '#e0a83c' : g.id === 'sif' ? '#2e6fb5' : '#d4493f';
      for (let k = 0; k < 7; k++) {
        const wave = Math.round(Math.sin(t * 5 + k * 0.9 + f.x) * 1.2);
        ctx.fillStyle = k % 3 === 2 ? '#f1e4c8' : cloth;
        ctx.fillRect(f.x + 1 + k, f.y - 12 + wave, 1, 4);
      }
    }
  }
}

function drawLights(ctx: CanvasRenderingContext2D, st: AmbientState, world: World, t: number, night: number): void {
  // torches: wavering flame + warm halo (brighter at night)
  for (const g of world.places) {
    for (const tc of g.torches) {
      const flick = 0.6 + 0.4 * Math.abs(Math.sin(t * 9 + tc.x * 0.3));
      const hh = 3 + Math.round(flick * 3);
      ctx.fillStyle = '#ff8c3b';
      ctx.fillRect(tc.x - 1, tc.y - hh, 3, hh);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(tc.x, tc.y - hh + 1, 1, hh - 2);
      if (night > 0.05) {
        ctx.fillStyle = `rgba(255,160,70,${(0.12 * night * flick).toFixed(3)})`;
        ctx.fillRect(tc.x - 12, tc.y - 16, 25, 26);
      }
    }
    if (g.campfire) {
      const c = g.campfire;
      const flick = Math.abs(Math.sin(t * 11 + 1.3));
      ctx.fillStyle = '#ff8c3b';
      ctx.fillRect(c.x - 3, c.y - 4 - Math.round(flick * 2), 6, 5);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(c.x - 1, c.y - 5 - Math.round(flick * 3), 3, 5);
      if (Math.random() < 0.3) spawn(st, { x: c.x, y: c.y - 4, vx: (Math.random() - 0.5) * 10, vy: -20 - Math.random() * 15, age: 0, ttl: 0.8, size: 1, color: '#ffd166', kind: 'spark' });
    }
  }
  // window glow at night: warm panes + flickering halos over the night tint
  if (night > 0.03) {
    for (const g of world.places) {
      for (const b of g.buildings) {
        const flick = 0.75 + 0.25 * Math.sin(t * 3.1 + b.rect.x * 0.07);
        ctx.fillStyle = `rgba(255,217,122,${(0.9 * night * flick).toFixed(3)})`;
        for (const r of b.glow) ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const g of world.places) {
      for (const b of g.buildings) {
        const flick = 0.75 + 0.25 * Math.sin(t * 3.1 + b.rect.x * 0.07);
        ctx.fillStyle = `rgba(255,180,80,${(0.1 * night * flick).toFixed(3)})`;
        for (const r of b.glow) ctx.fillRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

/** Particles, birds, bats and fireflies (drawn after heroes). */
export function drawAmbientFront(ctx: CanvasRenderingContext2D, st: AmbientState, world: World, t: number, night: number): void {
  for (const p of st.particles) {
    const k = p.age / p.ttl;
    let size = p.size;
    let alpha = 1;
    if (p.kind === 'smoke') {
      size = p.size + (p.grow ?? 2) * k * 2;
      alpha = 0.55 * (1 - k);
    } else if (p.kind === 'spark' || p.kind === 'flame' || p.kind === 'sparkle') {
      size = Math.max(1, p.size * (1 - k));
      alpha = 1 - k * 0.6;
    } else if (p.kind === 'puff') {
      size = p.size + k * 3;
      alpha = 0.8 * (1 - k);
    } else {
      alpha = Math.sin(k * Math.PI);
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    const s = Math.round(size);
    ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s);
  }
  ctx.globalAlpha = 1;
  drawLifeFront(ctx, st.life, world, t, night);
  if (st.reduced) return;
  // birds
  const frame = Math.floor(t * 6) % 2;
  for (const b of st.birds) {
    const rows = BIRD_FRAMES[(frame + Math.floor(b.phase)) % 2] ?? [];
    drawMatrix(ctx, rows, BIRD_PALETTE, Math.round(b.x), Math.round(b.y), 1, b.vx < 0);
  }
  // bats circling the dungeon mouth
  for (const g of world.places) {
    if (!g.bats) continue;
    for (let i = 0; i < 3; i++) {
      const a = t * (0.9 + i * 0.2) + i * 2.1;
      const bx = g.bats.x + Math.cos(a) * (40 + i * 14);
      const by = g.bats.y + Math.sin(a * 1.7) * 16 - i * 6;
      const rows = BAT_FRAMES[(Math.floor(t * 10) + i) % 2] ?? [];
      drawMatrix(ctx, rows, BAT_PALETTE, Math.round(bx), Math.round(by), 1, Math.cos(a) < 0);
    }
  }
}

export function emitSparkBurst(st: AmbientState, at: Pt, color: string, n: number, speed = 60): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    spawn(st, { x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30, age: 0, ttl: 0.6 + Math.random() * 0.4, size: 2, color, kind: 'sparkle' });
  }
}
