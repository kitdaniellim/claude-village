// 8-bit sound cues synthesised with WebAudio — no asset files. Mute state
// persists in localStorage; the AudioContext is unlocked on the first gesture
// and never plays more than one cue per 400 ms.

export type SoundCue = 'turn_done' | 'needs_you' | 'error' | 'session_new';

export const SOUND_STORAGE_KEY = 'rts-agents.sound.v1';
const MIN_GAP_MS = 400;
const MASTER_GAIN = 0.9;

interface Note {
  freq: number;
  /** Seconds after the cue starts. */
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

const CUES: Record<SoundCue, Note[]> = {
  // two rising notes (C5 → G5)
  turn_done: [
    { freq: 523.25, at: 0, dur: 0.09 },
    { freq: 783.99, at: 0.1, dur: 0.17 },
  ],
  // three-note fanfare (E5 → G5 → C6)
  needs_you: [
    { freq: 659.25, at: 0, dur: 0.09 },
    { freq: 783.99, at: 0.1, dur: 0.09 },
    { freq: 1046.5, at: 0.2, dur: 0.24 },
  ],
  // low detuned buzz
  error: [
    { freq: 110, at: 0, dur: 0.24, type: 'sawtooth', gain: 0.16 },
    { freq: 82.41, at: 0.03, dur: 0.22, type: 'square', gain: 0.12 },
  ],
  // quick blip
  session_new: [
    { freq: 880, at: 0, dur: 0.05 },
    { freq: 1174.66, at: 0.055, dur: 0.06 },
  ],
};

let ctx: AudioContext | null = null;
let enabled = loadSoundEnabled();
let lastPlayedAt = 0;

export function loadSoundEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SOUND_STORAGE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function isSoundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(v: boolean): void {
  enabled = v;
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, v ? '1' : '0');
  } catch {
    // storage unavailable — setting lives for this page load only
  }
}

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** Call from a user gesture: creates/resumes the context so later cues can play. */
export function unlockAudio(): void {
  const c = getContext();
  if (c && c.state === 'suspended') {
    c.resume().catch(() => {
      // still locked — the next gesture will try again
    });
  }
}

/** Plays a cue; returns false when muted, throttled or audio is still locked. */
export function playCue(cue: SoundCue): boolean {
  if (!enabled) return false;
  const now = performance.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return false;
  const c = getContext();
  if (!c || c.state !== 'running') return false;
  lastPlayedAt = now;

  const t0 = c.currentTime + 0.01;
  for (const n of CUES[cue]) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = n.type ?? 'square';
    osc.frequency.setValueAtTime(n.freq, t0 + n.at);
    const peak = (n.gain ?? 0.08) * MASTER_GAIN;
    gain.gain.setValueAtTime(0.0001, t0 + n.at);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.dur + 0.02);
  }
  return true;
}
