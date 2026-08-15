import { supabase } from "@/integrations/supabase/client";
import type { ArenaAnswer } from "@/lib/arena";


// Guest → account result claiming.
// The server issues a single-use, expiring claim token; the browser only ever
// holds that opaque token. Identity is never inferred from nickname or email.

export type PendingClaim = {
  token: string;
  kind: "session" | "arena";
  label: string;
  /** Where to send the player back to after the claim succeeds. */
  returnTo: string;
  createdAt: number;
};

const KEY = "brainbolt:pending-claim";

export function savePendingClaim(c: PendingClaim) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(c));
}

export function readPendingClaim(): PendingClaim | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as PendingClaim;
    // Mirror the server-side 24h expiry so we never show a stale prompt.
    if (!c.token || Date.now() - c.createdAt > 24 * 60 * 60 * 1000) {
      clearPendingClaim();
      return null;
    }
    return c;
  } catch {
    return null;
  }
}

export function clearPendingClaim() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

/** Proves ownership of a hosted-session seat with the participant secret. */
export async function createSessionClaim(participantId: string, secretToken: string): Promise<string> {
  const { data, error } = await (supabase as any).rpc("create_session_claim", {
    p_participant_id: participantId,
    p_secret_token: secretToken,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Issues a claim ticket for a guest Arena run. Raw answers only — the score
 * stored on the ticket is computed server-side.
 */
export async function createArenaClaim(
  quizId: string,
  answers: ArenaAnswer[],
): Promise<string> {
  const { data, error } = await (supabase as any).rpc("create_arena_claim", {
    p_quiz_id: quizId,
    p_answers: answers,
  });
  if (error) throw error;
  return data as string;
}


/** Redeems a token as the signed-in user. Server enforces single-use + expiry. */
export async function redeemClaim(token: string): Promise<{ kind: string }> {
  const { data, error } = await (supabase as any).rpc("claim_result", { p_token: token });
  if (error) throw error;
  return (data ?? { kind: "session" }) as { kind: string };
}
