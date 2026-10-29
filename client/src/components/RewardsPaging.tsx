// Paging for the quest log: a render limit that grows by one page per
// "Load 30 more" click, plus the button row that says how much is showing.

import { useCallback, useState } from 'react';

interface PagingState {
  resetKey: string;
  total: number;
  limit: number;
}

/**
 * Render limit that starts at one page, resets when `resetKey` changes and
 * grows with `total` so a fresh award never pushes shown rows off the end.
 */
export function usePagedLimit(total: number, pageSize: number, resetKey: string) {
  const [s, setS] = useState<PagingState>({ resetKey, total, limit: pageSize });
  let limit = s.limit;
  if (s.resetKey !== resetKey) {
    limit = pageSize;
    setS({ resetKey, total, limit });
  } else if (s.total !== total) {
    // A trickle of awards extends the limit; a first load or bulk reload keeps paging.
    const grow = total - s.total;
    if (s.total > 0 && grow > 0 && grow <= pageSize) limit = s.limit + grow;
    setS({ resetKey, total, limit });
  }
  const more = useCallback(() => setS((cur) => ({ ...cur, limit: cur.limit + pageSize })), [pageSize]);
  return { limit: Math.min(limit, total), more };
}

interface LoadMoreProps {
  shown: number;
  total: number;
  pageSize: number;
  onMore: () => void;
}

/** "Showing 30 of 235" + an explicit "Load 30 more" button (no infinite scroll). */
export function LoadMore({ shown, total, pageSize, onMore }: LoadMoreProps) {
  const next = Math.min(pageSize, total - shown);
  return (
    <div className="rp-more">
      <span className="rp-more-count">
        Showing <b>{shown}</b> of <b>{total}</b>
      </span>
      {next > 0 && (
        <button type="button" className="ui-btn rp-more-btn" onClick={onMore}>
          Load {next} more
        </button>
      )}
    </div>
  );
}
