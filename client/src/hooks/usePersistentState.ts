// useState that survives reloads/restarts: read from localStorage on mount and written
// back on every change. In the desktop app it is also backed up by the main process
// (prefs.json), because a restart can switch origin (file:// → localhost) and lose
// localStorage. Falls back silently when storage is blocked.

import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

const PREFIX = 'rts-agents.ui.';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
  isValid: (v: unknown) => v is T
): [T, Dispatch<SetStateAction<T>>] {
  const hadLocal = useRef(readLocal(key) !== null);
  const [value, setValue] = useState<T>(() => {
    const raw = readLocal(key);
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isValid(parsed)) return parsed;
      } catch {
        // unreadable — use the default
      }
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });

  // No local copy (fresh origin after a restart)? Take the desktop backup once. Until that
  // lookup settles, don't write the backup — the mount-time default would overwrite it.
  const [backupReady, setBackupReady] = useState(hadLocal.current || !window.rts?.prefs);
  useEffect(() => {
    if (backupReady) return;
    let live = true;
    const done = (): void => {
      if (live) setBackupReady(true);
    };
    window.rts?.prefs
      ?.load(key)
      .then((raw) => {
        if (raw === null || !live) return;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isValid(parsed)) setValue(parsed);
        } catch {
          // corrupt backup — keep the default
        }
      })
      .catch(() => undefined)
      .finally(done);
    return () => {
      live = false;
    };
    // isValid is a stable module-level guard in practice; key is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, backupReady]);

  useEffect(() => {
    const json = JSON.stringify(value);
    try {
      localStorage.setItem(PREFIX + key, json);
    } catch {
      // storage blocked — the value still lives for this session
    }
    if (backupReady) window.rts?.prefs?.save(key, json);
  }, [key, value, backupReady]);

  return [value, setValue];
}

export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
