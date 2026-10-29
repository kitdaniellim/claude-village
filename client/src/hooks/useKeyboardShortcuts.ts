// Global shortcuts: Ctrl+` terminal drawer (works everywhere), and M / Esc / "/"
// which are ignored while typing in an input or a terminal.

import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  toggleDrawer: () => void;
  toggleSound: () => void;
  closeDrawer: () => void;
  focusFilter: () => void;
}

/** Shown in the settings popover. */
export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl + `', what: 'Toggle terminal drawer' },
  { keys: 'M', what: 'Toggle sound cues' },
  { keys: 'Esc', what: 'Close drawer' },
  { keys: '/', what: 'Focus party filter' },
];

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return t.closest('.xterm') !== null;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
        e.preventDefault();
        ref.current.toggleDrawer();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case 'm':
        case 'M':
          ref.current.toggleSound();
          break;
        case 'Escape':
          ref.current.closeDrawer();
          break;
        case '/':
          e.preventDefault();
          ref.current.focusFilter();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
