import { supabase } from "@/integrations/supabase/client";

/**
 * One code space, two meanings. Hosted lobbies and scheduled/autonomous
 * competitions both live in `sessions.code`; the server tells us which one a
 * code belongs to so the player never has to know the difference.
 *
 * Scheduled competitions stay out of public discovery — a code is the only way
 * in, exactly as the host intended when they shared it.
 */
export type GameCodeLookup = {
  session_id: string;
  code: string;
  session_status: string;
  quiz_title: string | null;
  team_mode: boolean;
  kind: "hosted" | "scheduled";
  competition_title: string | null;
  scheduled_start_at: string | null;
  lobby_opens_at: string | null;
  autonomous: boolean;
};

export async function lookupGameCode(code: string): Promise<GameCodeLookup | null> {
  const { data, error } = await supabase.rpc("lookup_game_code", { p_code: code });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as GameCodeLookup | undefined) ?? null;
}

/** Plain-language explanation of what a code represents. */
export function describeGameCode(info: GameCodeLookup): { label: string; detail: string } {
  const title = info.competition_title ?? info.quiz_title ?? "Quiz match";
  if (info.kind === "scheduled" && info.scheduled_start_at) {
    const start = new Date(info.scheduled_start_at);
    const soon = start.getTime() - Date.now();
    const when =
      soon > 0
        ? `Starts ${start.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
        : "Starting now";
    return {
      label: "Scheduled competition",
      detail: `${title} · ${when}${info.autonomous ? " · runs automatically" : ""}`,
    };
  }
  if (info.session_status === "lobby") {
    return { label: "Live lobby", detail: `${title} · the host is waiting for players` };
  }
  if (info.session_status === "ended") {
    return { label: "Finished", detail: `${title} · this match has already ended` };
  }
  return { label: "Match in progress", detail: `${title} · you can still jump in` };
}
