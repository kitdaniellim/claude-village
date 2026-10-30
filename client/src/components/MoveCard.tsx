// "Move into the village": one button that closes every Claude Code session running in an outside
// terminal and resumes it in a village tab. Confirms first (it ends processes); sessions mid-turn
// wait and move when their turn ends. Desktop app only.

import { useState } from 'react';
import type { MoveStatus } from './TerminalPanel';
import './MoveCard.css';

interface MoveCardProps {
  status: MoveStatus | null;
  onMove: () => void;
  onCancel: () => void;
  /** Older desktop shell without the release call: restart rebuilds it. */
  onRestart: (() => void) | null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export default function MoveCard({ status, onMove, onCancel, onRestart }: MoveCardProps) {
  const [confirming, setConfirming] = useState(false);
  if (!status?.desktop) return null;
  const { outside, waiting, supported } = status;
  const movable = outside - waiting;
  if (outside === 0 && waiting === 0) return null;

  if (!supported) {
    return (
      <section className="move" aria-label="Move outside terminals into the village">
        <span className="move-note">
          {plural(outside, 'session runs', 'sessions run')} in outside terminals. Restart the app once to enable moving them here.
        </span>
        {onRestart && (
          <button type="button" className="ui-btn move-btn" onClick={onRestart}>
            ↻ Restart app
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="move" aria-label="Move outside terminals into the village">
      {!confirming && movable > 0 && (
        <button
          type="button"
          className="ui-btn move-btn"
          onClick={() => setConfirming(true)}
          title="Close the Claude sessions running in outside terminals and resume them in village tabs"
        >
          ⇲ Move {plural(movable, 'terminal', 'terminals')} into the village
        </button>
      )}
      {confirming && (
        <div className="move-confirm" role="alertdialog" aria-label="Confirm move">
          <span className="move-note">
            Closes {plural(movable, 'Claude session', 'Claude sessions')} in outside terminals and resumes{' '}
            {movable === 1 ? 'it' : 'them'} here. Sessions mid-turn wait until they finish. Text typed out there but not
            sent is lost.
          </span>
          <span className="move-row">
            <button
              type="button"
              className="ui-btn ui-btn-primary move-btn"
              onClick={() => {
                setConfirming(false);
                onMove();
              }}
            >
              Move {movable}
            </button>
            <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {waiting > 0 && (
        <span className="move-waiting">
          <span title="They move here the moment their current turn ends">⏳ {waiting} waiting for a turn to end</span>
          <button type="button" className="move-link" onClick={onCancel}>
            Cancel
          </button>
        </span>
      )}
    </section>
  );
}
