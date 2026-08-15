import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type LiveStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

type Options = {
  /** Only subscribe once prerequisites (identity, ids) are ready. */
  enabled: boolean;
  /** Stable channel name. Changing it tears down and rebuilds the channel. */
  name: string;
  /** Attach listeners. Called once per (re)subscribe with a fresh channel. */
  setup: (channel: RealtimeChannel) => RealtimeChannel;
  /**
   * Re-read authoritative state from the server. Called after every successful
   * (re)subscribe and when the tab returns to the foreground. Never replays
   * missed events — it always reconstructs from current server state.
   */
  onResync: () => void | Promise<void>;
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * One realtime channel per mount, with predictable
 * connected -> disconnected -> reconnecting -> reconnected handling.
 *
 * Guarantees:
 * - exactly one channel and one reconnect timer are alive at a time
 * - the channel is removed on unmount / dependency change
 * - reconnection re-reads authoritative state instead of replaying events
 */
export function useLiveChannel({ enabled, name, setup, onResync }: Options) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [recovered, setRecovered] = useState(false);

  const setupRef = useRef(setup);
  const resyncRef = useRef(onResync);
  setupRef.current = setup;
  resyncRef.current = onResync;

  const channelRef = useRef<RealtimeChannel | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const everConnectedRef = useRef(false);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;
    everConnectedRef.current = false;
    attemptRef.current = 0;

    const teardown = () => {
      clearTimer();
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (!mountedRef.current) return;
      clearTimer();
      const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)];
      attemptRef.current += 1;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (!mountedRef.current) return;
      teardown();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStatus("offline");
        scheduleReconnect();
        return;
      }
      setStatus(everConnectedRef.current ? "reconnecting" : "connecting");
      const ch = setupRef.current(supabase.channel(name));
      channelRef.current = ch;
      ch.subscribe((s) => {
        if (!mountedRef.current) return;
        if (s === "SUBSCRIBED") {
          const wasDown = everConnectedRef.current;
          everConnectedRef.current = true;
          attemptRef.current = 0;
          clearTimer();
          setStatus("connected");
          void resyncRef.current();
          if (wasDown) {
            setRecovered(true);
            setTimeout(() => mountedRef.current && setRecovered(false), 2500);
          }
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          setStatus(everConnectedRef.current ? "reconnecting" : "error");
          scheduleReconnect();
        }
      });
    };

    connect();

    // Network + lifecycle transitions: Wi-Fi <-> mobile data, screen lock,
    // tab suspension. Each one only ever nudges the single connect loop.
    const onOnline = () => {
      attemptRef.current = 0;
      connect();
    };
    const onOffline = () => setStatus("offline");
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (channelRef.current?.state === "joined") {
        void resyncRef.current();
      } else {
        attemptRef.current = 0;
        connect();
      }
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      teardown();
    };
  }, [enabled, name, clearTimer]);

  return { status, recovered };
}
