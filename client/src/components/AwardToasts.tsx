// Award toasts under the backpack button: icon + "+1 Iron Ore" + the hero's name (click → its
// summary in the backpack), framed in the item's colour with a sparkle. Up to 3 stack, each auto-dismisses after 4 s,
// and the reward jingle plays once per award (respects mute).

import { useEffect, useRef, useState } from 'react';
import type { ItemDef, JournalEntry, RewardsState } from '../types/agent';
import type { LastAward } from '../hooks/useAgentSocket';
import { catalogMap, lookupItem } from '../utils/rewards';
import { epithetTitle } from '../utils/epithet';
import { playCueSoon } from '../utils/sound';
import { heroColor } from '../utils/spriteMapper';
import { ItemIcon } from './ItemIcon';
import { Portrait } from './Portrait';
import './AwardToasts.css';

interface AwardToastsProps {
  lastAward: LastAward | null;
  rewards: RewardsState | null;
  /** Clicked: open the backpack on this entry's summary. */
  onOpen?: (entryId: string) => void;
}

interface Toast {
  id: number;
  award: JournalEntry;
  item: ItemDef;
  leaving: boolean;
}

const TOAST_MS = 4000;
const EXIT_MS = 220;
const MAX_TOASTS = 3;

export default function AwardToasts({ lastAward, rewards, onOpen }: AwardToastsProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenNonce = useRef(0);
  const timers = useRef<number[]>([]);
  const rewardsRef = useRef(rewards);
  rewardsRef.current = rewards;

  useEffect(() => {
    if (!lastAward || lastAward.nonce === seenNonce.current) return;
    seenNonce.current = lastAward.nonce;
    const id = lastAward.nonce;
    const item = lookupItem(catalogMap(rewardsRef.current), lastAward.award.itemId);
    setToasts((t) => [...t.slice(-(MAX_TOASTS - 1)), { id, award: lastAward.award, item, leaving: false }]);
    playCueSoon('reward');
    timers.current.push(
      window.setTimeout(() => {
        setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      }, TOAST_MS),
      window.setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, TOAST_MS + EXIT_MS),
    );
  }, [lastAward]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) window.clearTimeout(t);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.item.rarity} ${t.leaving ? 'toast-leave' : ''}`}
          onClick={() => {
            setToasts((all) => all.filter((x) => x.id !== t.id));
            onOpen?.(t.award.id);
          }}
          role="status"
          title="Open the summary in the backpack"
        >
          <span className="toast-sparkle" aria-hidden="true" />
          <span className="toast-icon">
            <ItemIcon itemId={t.item.id} scale={1} />
          </span>
          <span className="toast-body">
            <span className="toast-title">+1 {t.item.name}</span>
            <span className="toast-sub" title={epithetTitle(t.award.sessionId, t.award.sessionName ?? t.award.shortId)}>
              {t.award.sessionName ?? t.award.shortId}
            </span>
          </span>
          {/* Who earned it — the hero's face on the right. */}
          <Portrait
            sessionId={t.award.sessionId}
            color={heroColor(t.award.sessionId)}
            className="toast-hero"
            label={epithetTitle(t.award.sessionId, t.award.sessionName ?? t.award.shortId)}
          />
        </div>
      ))}
    </div>
  );
}
