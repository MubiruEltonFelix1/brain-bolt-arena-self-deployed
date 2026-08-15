import { useCallback, useEffect, useRef } from "react";

/**
 * Coalesces bursts of calls into a single trailing invocation.
 *
 * Realtime tables emit one row event per participant; without this a 40-player
 * lobby fires 40 identical full-table refetches. The server stays the source of
 * truth — we simply refetch once the burst settles.
 */
export function useCoalescedCallback(fn: () => void | Promise<void>, waitMs = 250) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void fnRef.current();
    }, waitMs);
  }, [waitMs]);
}
