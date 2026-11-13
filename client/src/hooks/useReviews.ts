// Party Leader verdicts from GET /api/reviews, polled while anything is opted in to review.

import { useEffect, useState } from 'react';
import type { ReviewVerdict, ReviewsResponse } from '../types/agent';
import { serverHttpUrl } from './useAgentSocket';

const POLL_MS = 4_000;

/** `ready` turns true after the first successful load — until then "no verdict" means "not known yet". */
export function useReviews(active: boolean): { verdicts: ReviewVerdict[]; ready: boolean } {
  const [verdicts, setVerdicts] = useState<ReviewVerdict[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = (): void => {
      fetch(`${serverHttpUrl()}/api/reviews`)
        .then((r) => (r.ok ? (r.json() as Promise<ReviewsResponse>) : null))
        .then((res) => {
          if (!live || !res || !Array.isArray(res.verdicts)) return;
          setReady(true);
          setVerdicts((cur) => (JSON.stringify(cur) === JSON.stringify(res.verdicts) ? cur : res.verdicts));
        })
        .catch(() => {
          // server restarting — keep the last verdicts
        });
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [active]);
  return { verdicts, ready };
}
