// Phase 9B — Arena creator server functions.
//
// These wrap the creator-axis RPCs that the Quiz Editor's new
// "Arena Publishing" section calls when a quiz owner wants to publish /
// hide / set the category of their quiz. The server enforces ownership
// + admin-override inside each RPC; the middleware only authenticates.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Same rationale as src/lib/api/arena-admin.functions.ts.

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const uuid = z.string().uuid();

export const setArenaPublicationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      p_quiz_id: uuid,
      p_status: z.enum(["draft", "published", "hidden"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { data: result, error } = await supabase.rpc("set_arena_publication_status", {
      p_quiz_id: data.p_quiz_id,
      p_status: data.p_status,
    });
    if (error) {
      const msg = String((error as { message?: string })?.message ?? "");
      console.error("[arena/setArenaPublicationStatus] failed", { userId, error });
      if (msg.includes("not_eligible")) {
        return {
          ok: false as const,
          error: "not_eligible" as const,
          state: null,
        };
      }
      if (msg.includes("not_authorized")) {
        return { ok: false as const, error: "unauthorized" as const, state: null };
      }
      if (msg.includes("quiz_not_found")) {
        return { ok: false as const, error: "not_found" as const, state: null };
      }
      return { ok: false as const, error: "unknown" as const, state: null };
    }
    return { ok: true as const, error: null, state: result };
  });

export const setArenaCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      p_quiz_id: uuid,
      p_category: z.string().trim().max(80),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("set_arena_category", {
      p_quiz_id: data.p_quiz_id,
      p_category: data.p_category,
    });
    if (error) {
      console.error("[arena/setArenaCategory] failed", { userId, error });
      const msg = String((error as { message?: string })?.message ?? "");
      if (msg.includes("not_authorized")) {
        return { ok: false as const, error: "unauthorized" as const };
      }
      if (msg.includes("quiz_not_found")) {
        return { ok: false as const, error: "not_found" as const };
      }
      return { ok: false as const, error: "unknown" as const };
    }
    return { ok: true as const, error: null };
  });
