import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { emitJoinEvent } from "@/lib/join-telemetry";

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
  /**
   * Phase 9D.2 P0-A: private channels are authorized against
   * `realtime.messages` RLS. The live-game session topic is private so that
   * database-side broadcast (`realtime.send`) reaches subscribers while
   * clients themselves cannot publish to it.
   */
  private?: boolean;
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
 * How long a single attempt may stay CONNECTING before the UI escalates from a
 * quiet "CONNECTING" pill to an explicit "Reconnecting to game…" warning. Long
 * enough that a normal cold join never flashes it, short enough that a player
 * on a weak connection is told what is happening well before they give up.
 */
export const JOIN_HEALTH_MS = 6000;

/**
 * One realtime channel per mount, with predictable
 * connected -> disconnected -> reconnecting -> reconnected handling.
 *
 * Guarantees:
 * - exactly one channel and one reconnect timer are alive at a time
 * - the channel is removed on unmount / dependency change
 * - reconnection re-reads authoritative state instead of replaying events
 */
export function useLiveChannel({ enabled, name, setup, onResync, private: isPrivate }: Options) {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [recovered, setRecovered] = useState(false);
  /**
   * True once a single attempt has been CONNECTING for longer than
   * JOIN_HEALTH_MS. Purely a UI signal — it never schedules or alters a
   * reconnect; the backoff loop below stays the only connection authority.
   */
  const [stalled, setStalled] = useState(false);

  const setupRef = useRef(setup);
  const resyncRef = useRef(onResync);
  setupRef.current = setup;
  resyncRef.current = onResync;

  const channelRef = useRef<RealtimeChannel | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptStartedAtRef = useRef(0);
  const attemptRef = useRef(0);
  const everConnectedRef = useRef(false);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (healthTimerRef.current) {
      clearTimeout(healthTimerRef.current);
      healthTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;
    everConnectedRef.current = false;
    attemptRef.current = 0;
    emitJoinEvent({ event: "subscribe_started", channel: name, attempt: 0 });

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
      emitJoinEvent({
        event: "backoff",
        channel: name,
        attempt: attemptRef.current,
        delayMs: delay,
      });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (!mountedRef.current) return;
      teardown();
      // Cleared here rather than further down: a stall left over from a previous
      // attempt would otherwise keep the banner claiming "Reconnecting to
      // game…" while status is "offline" and the client has positively
      // determined there is no network to reconnect to.
      setStalled(false);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStatus("offline");
        scheduleReconnect();
        return;
      }
      setStatus(everConnectedRef.current ? "reconnecting" : "connecting");
      const isReconnect = everConnectedRef.current;
      attemptStartedAtRef.current = Date.now();
      // Join-health threshold. Fires once per attempt if the attempt has not
      // resolved; cleared by clearTimer() on success, failure or teardown.
      healthTimerRef.current = setTimeout(() => {
        healthTimerRef.current = null;
        if (mountedRef.current) setStalled(true);
      }, JOIN_HEALTH_MS);
      emitJoinEvent({
        event: isReconnect ? "reconnect_attempt" : "join_attempt",
        channel: name,
        attempt: attemptRef.current,
      });
      const ch = setupRef.current(
        isPrivate
          ? supabase.channel(name, { config: { private: true } })
          : supabase.channel(name),
      );
      channelRef.current = ch;
      ch.subscribe((s) => {
        if (!mountedRef.current) return;
        if (s === "SUBSCRIBED") {
          const wasDown = everConnectedRef.current;
          // Captured before the reset below: a reconnect_success must report the
          // attempt that actually succeeded, otherwise a success after four
          // backoffs is indistinguishable from the first try and the backoff
          // events cannot be paired with the success they led to.
          const attempt = attemptRef.current;
          everConnectedRef.current = true;
          attemptRef.current = 0;
          const connectMs = Date.now() - attemptStartedAtRef.current;
          clearTimer();
          setStalled(false);
          setStatus("connected");
          emitJoinEvent({
            event: wasDown ? "reconnect_success" : "join_success",
            channel: name,
            attempt,
            connectMs,
          });
          void resyncRef.current();
          if (wasDown) {
            setRecovered(true);
            setTimeout(() => mountedRef.current && setRecovered(false), 2500);
          }
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          emitJoinEvent({
            event: "join_failure",
            channel: name,
            attempt: attemptRef.current,
            reason: s,
            connectMs: Date.now() - attemptStartedAtRef.current,
          });
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
    // Cleared with the status: leaving `stalled` set here would keep the banner
    // reading "Reconnecting to game…" for a client that just told us it is
    // offline, which is the one message the player most needs to be accurate.
    const onOffline = () => {
      setStalled(false);
      setStatus("offline");
    };
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
  }, [enabled, name, clearTimer, isPrivate]);

  return { status, recovered, stalled };
}
