import { supabase } from "@/integrations/supabase/client";

let serverSkewMs = 0;
let bestRttMs = Number.POSITIVE_INFINITY;
let lastSyncAtMs = 0;

/**
 * NTP-style calibration: skew = serverNow - (t0 + rtt/2).
 * We take a few samples in a burst and keep the one with the lowest RTT
 * (smallest measurement error). Called on mount, every 30s, on visibility
 * regain, and immediately before a new intro window is expected.
 */
export async function syncServerClock(force = false): Promise<number> {
  // Cheap coalesce: if we synced very recently and it wasn't forced, skip.
  if (!force && Date.now() - lastSyncAtMs < 1000) return serverSkewMs;
  try {
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const { data, error } = await supabase.rpc("get_server_time");
      const t1 = Date.now();
      if (error || !data) continue;
      const serverNow = new Date(data as unknown as string).getTime();
      if (!Number.isFinite(serverNow)) continue;
      const rtt = t1 - t0;
      // Always accept the first successful sample; then only if RTT improves,
      // or if the stored estimate is older than 60s (drift refresh).
      const stale = Date.now() - lastSyncAtMs > 60_000;
      if (rtt < bestRttMs || stale || lastSyncAtMs === 0) {
        bestRttMs = rtt;
        serverSkewMs = serverNow - (t0 + Math.round(rtt / 2));
      }
      lastSyncAtMs = Date.now();
    }
    return serverSkewMs;
  } catch {
    return serverSkewMs;
  }
}

export function getServerSkewMs(): number {
  return serverSkewMs;
}

export function getServerAdjustedNow(): number {
  return Date.now() + serverSkewMs;
}
