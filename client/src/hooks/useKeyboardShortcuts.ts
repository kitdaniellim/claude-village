// Global shortcuts: Ctrl+` drawer and Ctrl+Shift+F terminal focus mode (work
// everywhere, the terminal included); single keys (A feed, B backpack, M mute,
// Esc, "/") are ignored while typing in an input or a terminal.

import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  toggleDrawer: () => void;
  toggleSound: () => void;
  toggleFeed: () => void;
  toggleBackpack: () => void;
  toggleTerminalFocus: () => void;
  /** Esc: the caller closes whatever is top-most (panel, then drawer). */
  escape: () => void;
  focusFilter: () => void;
}

/** Shown in the settings popover. */
export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Ctrl + `', what: 'Toggle terminal drawer' },
  { keys: 'A', what: 'Collapse / expand activity' },
  { keys: 'Ctrl + Shift + F', what: 'Terminal focus mode' },
  { keys: 'Ctrl + Shift + C / V', what: 'Copy / paste in the terminal' },
  { keys: 'B', what: 'Open backpack (quest log)' },
  { keys: 'M', what: 'Toggle sound cues' },
  { keys: 'Esc', what: 'Close panel / drawer' },
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
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyF') {
        e.preventDefault();
        ref.current.toggleTerminalFocus();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case 'a':
        case 'A':
          ref.current.toggleFeed();
          break;
        case 'b':
        case 'B':
          ref.current.toggleBackpack();
          break;
        case 'm':
        case 'M':
          ref.current.toggleSound();
          break;
        case 'Escape':
          ref.current.escape();
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
