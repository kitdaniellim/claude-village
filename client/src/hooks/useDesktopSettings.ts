// Desktop-only settings (launch at login, start minimised, sound mirror) over
// the window.rts bridge. `bridge` is null in a plain browser tab.

import { useCallback, useEffect, useState } from 'react';
import type { DesktopBridge, DesktopSettings } from '../types/desktop';

export interface DesktopSettingsControl {
  bridge: DesktopBridge | null;
  /** Null until loaded (or forever, without the bridge). */
  settings: DesktopSettings | null;
  update: (patch: Partial<DesktopSettings>) => void;
}

export function getDesktopBridge(): DesktopBridge | null {
  return typeof window !== 'undefined' ? (window.rts ?? null) : null;
}

export function useDesktopSettings(): DesktopSettingsControl {
  const [bridge] = useState<DesktopBridge | null>(getDesktopBridge);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .getSettings()
      .then((s) => {
        if (live) setSettings(s);
      })
      .catch(() => {
        // bridge answered badly — rows stay disabled
      });
    return () => {
      live = false;
    };
  }, [bridge]);

  const update = useCallback(
    (patch: Partial<DesktopSettings>) => {
      if (!bridge) return;
      setSettings((s) => (s ? { ...s, ...patch } : s)); // optimistic
      bridge
        .setSettings(patch)
        .then((s) => setSettings(s))
        .catch(() => {
          // keep the optimistic value; the next load re-syncs
        });
    },
    [bridge],
  );

  return { bridge, settings, update };
}
