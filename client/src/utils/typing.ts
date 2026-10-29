// "You're typing" signal from the embedded terminals to the village. Only keystrokes
// typed into the desktop app's own terminals are visible — external terminals never are.

export const TYPING_EVENT = 'rts:typing';

export interface TypingDetail {
  sessionId: string;
  /** True when the keystroke contained Enter — the prompt was sent. */
  sent: boolean;
}
