// Phase 9D.3: minimal, production-safe join/reconnect observability.
//
// Every call here is a counter write or a single compact line — there is no
// polling, no queue and no per-event DOM work, so it is safe to leave enabled
// in production. Events carry no player data: the channel name is hashed to a
// short id, so a line can be correlated across the join and the reconnect of
// one session without exposing session ids, nicknames or tokens. The hash is a
// correlator, not a key: it is 32-bit and not reversible, so a collision would
// merge two sessions' first-join timing. That is a cosmetic metric only — the
// counters below are global, never per-channel.

export type JoinEventName =
  | "subscribe_started"
  | "join_attempt"
  | "join_success"
  | "join_failure"
  | "reconnect_attempt"
  | "reconnect_success"
  | "backoff";

export type JoinEvent = {
  event: JoinEventName;
  /** Hashed topic id, never the raw channel name. */
  channel: string;
  attempt: number;
  /** Set on `backoff`. */
  delayMs?: number;
  /** Set on `join_success` / `reconnect_success`: attempt -> SUBSCRIBED. */
  connectMs?: number;
  /** Set on `join_failure`. */
  reason?: string;
  at: number;
};

export type JoinCounters = {
  subscribeStarted: number;
  joinAttempts: number;
  joinSuccesses: number;
  joinFailures: number;
  reconnectAttempts: number;
  reconnectSuccesses: number;
  /** Time from the first join attempt to the first successful join. */
  timeToFirstJoinMs: number | null;
  /** Longest single attempt -> SUBSCRIBED time seen this page. */
  slowestConnectMs: number;
};

/** FNV-1a, 32-bit. Short, stable, and not reversible into a session id. */
function hashChannel(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const counters: JoinCounters = {
  subscribeStarted: 0,
  joinAttempts: 0,
  joinSuccesses: 0,
  joinFailures: 0,
  reconnectAttempts: 0,
  reconnectSuccesses: 0,
  timeToFirstJoinMs: null,
  slowestConnectMs: 0,
};

const firstAttemptAt = new Map<string, number>();

/**
 * Optional production sink. A host app can assign
 * `window.__brainboltJoinTelemetry = (e) => navigator.sendBeacon(...)` to ship
 * these lines off-box without this module knowing anything about the stack.
 */
type JoinSink = (e: JoinEvent) => void;

function record(e: JoinEvent) {
  switch (e.event) {
    case "subscribe_started":
      counters.subscribeStarted += 1;
      break;
    case "join_attempt":
      counters.joinAttempts += 1;
      if (!firstAttemptAt.has(e.channel)) {
        // Bounded so a long-lived tab that plays many sessions cannot grow this
        // map without limit. Insertion order is the play order, so the first key
        // is the oldest.
        if (firstAttemptAt.size >= 64) {
          const oldest = firstAttemptAt.keys().next().value;
          if (oldest !== undefined) firstAttemptAt.delete(oldest);
        }
        firstAttemptAt.set(e.channel, e.at);
      }
      break;
    case "join_success": {
      counters.joinSuccesses += 1;
      const ms = e.connectMs ?? 0;
      const started = firstAttemptAt.get(e.channel);
      if (started !== undefined && counters.timeToFirstJoinMs === null) {
        counters.timeToFirstJoinMs = e.at - started;
      }
      if (ms > counters.slowestConnectMs) counters.slowestConnectMs = ms;
      break;
    }
    case "join_failure":
      counters.joinFailures += 1;
      break;
    case "reconnect_attempt":
      counters.reconnectAttempts += 1;
      break;
    case "reconnect_success":
      counters.reconnectSuccesses += 1;
      break;
    case "backoff":
      break;
  }
}

/** Export for diagnostics and for the scale-audit harness. */
export function joinTelemetryCounters(): Readonly<JoinCounters> {
  return { ...counters };
}

export function emitJoinEvent(
  event: Omit<JoinEvent, "channel" | "at"> & { channel: string },
): void {
  const e: JoinEvent = { ...event, channel: hashChannel(event.channel), at: Date.now() };
  record(e);
  const sink = (globalThis as { __brainboltJoinTelemetry?: JoinSink }).__brainboltJoinTelemetry;
  if (sink) {
    try {
      sink(e);
    } catch {
      // A broken sink must never break the join path.
    }
  }
  if (import.meta.env.DEV) {
    console.debug("[join]", e.event, e.channel, `attempt=${e.attempt}`, e);
  }
}
