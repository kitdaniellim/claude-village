// Sound state + cue triggers: diffs agent statuses between broadcasts (and
// watches feed events for new sessions) and fires 8-bit cues on the
// transitions that matter. Unlocks the AudioContext on the first gesture.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent, AgentState, AgentStatus } from '../types/agent';
import { isSoundEnabled, playCue, setSoundEnabled, unlockAudio } from '../utils/sound';
import type { SoundCue } from '../utils/sound';

export interface SoundControl {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
}

/** Most urgent first — one cue per broadcast, the limiter drops the rest anyway. */
const PRIORITY: SoundCue[] = ['error', 'needs_you', 'turn_done', 'session_new'];
const MAX_SEEN_EVENTS = 400;

export function useSound(
  agents: AgentState[],
  events: ActivityEvent[],
  selectedSessionId: string | null,
): SoundControl {
  const [enabled, setEnabledState] = useState<boolean>(isSoundEnabled);
  const prevStatus = useRef<Map<string, AgentStatus> | null>(null);
  const seenEvents = useRef<Set<string> | null>(null);
  const selectedRef = useRef(selectedSessionId);
  selectedRef.current = selectedSessionId;

  useEffect(() => {
    const unlock = (): void => unlockAudio();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);

  // Status transitions: running/thinking → done is "your turn"; → error buzzes.
  useEffect(() => {
    const prev = prevStatus.current;
    const next = new Map<string, AgentStatus>();
    for (const a of agents) next.set(a.sessionId, a.status);
    prevStatus.current = next;
    if (!prev) return;

    const cues: SoundCue[] = [];
    for (const a of agents) {
      const was = prev.get(a.sessionId);
      if (was === undefined || was === a.status) continue;
      if (a.status === 'done' && (was === 'running' || was === 'thinking')) {
        // The session you're looking at gets the soft chime; others call louder.
        cues.push(a.sessionId === selectedRef.current ? 'turn_done' : 'needs_you');
      } else if (a.status === 'error') {
        cues.push('error');
      }
    }
    const pick = PRIORITY.find((c) => cues.includes(c));
    if (pick) playCue(pick);
  }, [agents]);

  // New sessions come from the feed so the initial snapshot never blips.
  useEffect(() => {
    const seen = seenEvents.current;
    if (!seen) {
      seenEvents.current = new Set(events.map((e) => e.id));
      return;
    }
    let fresh = false;
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.kind === 'session_new') fresh = true;
    }
    if (seen.size > MAX_SEEN_EVENTS) {
      const keep = new Set(events.map((e) => e.id));
      seenEvents.current = keep;
    }
    if (fresh) playCue('session_new');
  }, [events]);

  const setEnabled = useCallback((v: boolean) => {
    setSoundEnabled(v);
    setEnabledState(v);
  }, []);

  const toggle = useCallback(() => {
    const v = !isSoundEnabled();
    setSoundEnabled(v);
    setEnabledState(v);
  }, []);

  return { enabled, setEnabled, toggle };
}
