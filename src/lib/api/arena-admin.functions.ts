// Phase 9B — Arena admin server functions.
//
// Pattern mirrors src/lib/api/ai.functions.ts:
//   createServerFn({ method: "POST" })
//     .middleware([requireSupabaseAuth])
//     .inputValidator(z.object(...))
//     .handler(async ({ data, context }) => { ... })
//
// Every handler:
//   1. Authenticates via requireSupabaseAuth (Bearer JWT).
//   2. Authorizes via `is_admin()` server-side (the middleware only verifies
//      a valid token; admin gating lives inside each handler).
//   3. Returns a typed envelope — never throws raw provider / PostgREST
//      errors. Failed calls return { ok: false, error: "<code>" }.
//
// Per-action RPCs (matches the established admin convention:
// `admin_grant_host_authorization`, `admin_revoke_host_authorization`,
// `admin_approve_host_request`, etc.).

/* eslint-disable @typescript-eslint/no-explicit-any */
// The handler context types are `as any` because the createServerFn context
// type isn't fully exported. The shape is verified at runtime via the
// `requireSupabaseAuth` middleware. Same pattern as src/lib/api/ai.functions.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const uuid = z.string().uuid();

/* ---------------- platform on/off ---------------- */

export const adminSetArenaOpen = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_open: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_set_arena_open", { p_open: data.p_open });
    if (error) {
      console.error("[arena/adminSetArenaOpen] failed", { userId, error });
      return { ok: false as const, error: "unknown" as const };
    }
    return { ok: true as const };
  });

/* ---------------- per-action moderation ---------------- */

export const adminArenaQuizPublish = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_publish", { p_quiz_id: data.p_quiz_id });
    if (error) {
      console.error("[arena/adminArenaQuizPublish] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizUnpublish = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_unpublish", {
      p_quiz_id: data.p_quiz_id,
    });
    if (error) {
      console.error("[arena/adminArenaQuizUnpublish] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizHide = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_hide", { p_quiz_id: data.p_quiz_id });
    if (error) {
      console.error("[arena/adminArenaQuizHide] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizUnhide = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_unhide", { p_quiz_id: data.p_quiz_id });
    if (error) {
      console.error("[arena/adminArenaQuizUnhide] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizArchive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_archive", {
      p_quiz_id: data.p_quiz_id,
    });
    if (error) {
      console.error("[arena/adminArenaQuizArchive] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizRestore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_restore", {
      p_quiz_id: data.p_quiz_id,
    });
    if (error) {
      console.error("[arena/adminArenaQuizRestore] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizFeature = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid, p_rank: z.number().int().min(1).max(1000) }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_feature", {
      p_quiz_id: data.p_quiz_id,
      p_rank: data.p_rank,
    });
    if (error) {
      console.error("[arena/adminArenaQuizFeature] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminArenaQuizUnfeature = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_unfeature", {
      p_quiz_id: data.p_quiz_id,
    });
    if (error) {
      console.error("[arena/adminArenaQuizUnfeature] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

/* ---------------- featured quiz metadata (editorial / verification) ---------------- */

export const adminArenaQuizUpdate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      p_quiz_id: uuid,
      p_title: z.string().trim().min(1).max(200),
      p_description: z.string().trim().min(1).max(1000),
      p_category: z.string().trim().min(1).max(80),
      p_difficulty: z.enum(["easy", "medium", "hard"]),
      p_time_per_question: z.number().int().min(5).max(120).optional(),
      p_estimated_duration_minutes: z.number().int().min(1).max(180).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_arena_quiz_update", {
      p_quiz_id: data.p_quiz_id,
      p_title: data.p_title,
      p_description: data.p_description,
      p_category: data.p_category,
      p_difficulty: data.p_difficulty,
      p_time_per_question: data.p_time_per_question ?? null,
      p_estimated_duration_minutes: data.p_estimated_duration_minutes ?? null,
    });
    if (error) {
      console.error("[arena/adminArenaQuizUpdate] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminFeaturedQuizMetadataSet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      p_quiz_id: uuid,
      p_source_references: z.array(
        z.object({
          url: z.string().url(),
          title: z.string().trim().min(1).max(200),
          accessed_at: z.string().optional(),
        }),
      ),
      p_verification_notes: z.string().trim().max(2000).optional(),
      p_verified_through_date: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase.rpc("admin_featured_quiz_metadata_set", {
      p_quiz_id: data.p_quiz_id,
      p_source_references: JSON.stringify(
        data.p_source_references.map((r) => ({
          url: r.url,
          title: r.title,
          accessed_at: r.accessed_at ?? new Date().toISOString(),
        })),
      ),
      p_verification_notes: data.p_verification_notes ?? "",
      p_verified_through_date: data.p_verified_through_date ?? null,
    });
    if (error) {
      console.error("[arena/adminFeaturedQuizMetadataSet] failed", { userId, error });
      return { ok: false as const, error: classifyAdminError(error) };
    }
    return { ok: true as const };
  });

export const adminFeaturedQuizMetadataGet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ p_quiz_id: uuid }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { data: result, error } = await supabase.rpc("admin_featured_quiz_metadata_get", {
      p_quiz_id: data.p_quiz_id,
    });
    if (error) {
      console.error("[arena/adminFeaturedQuizMetadataGet] failed", { userId, error });
      return {
        ok: false as const,
        error: classifyAdminError(error),
        metadata: null,
      };
    }
    return {
      ok: true as const,
      error: null,
      metadata: (result as { source_references: unknown; verification_notes: string; verified_through_date: string | null; verified_through_at: string | null; updated_by: string | null; updated_at: string | null } | null) ?? null,
    };
  });

/* ---------------- helpers ---------------- */

function classifyAdminError(
  error: unknown,
): "unauthorized" | "not_found" | "quiz_archived" | "unknown" {
  const msg = String((error as { message?: string })?.message ?? "").toLowerCase();
  if (
    msg.includes("not_authorized") ||
    msg.includes("insufficient privilege") ||
    msg.includes("permission denied")
  ) {
    return "unauthorized";
  }
  if (msg.includes("quiz_not_found") || msg.includes("not found")) {
    return "not_found";
  }
  if (msg.includes("quiz_archived")) {
    return "quiz_archived";
  }
  return "unknown";
}
