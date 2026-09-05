// Server-only helper: writes a row to public.ai_usage_log via supabaseAdmin.
//
// The ai_usage_log table has RLS enabled with no explicit policy — so the
// only writer that bypasses the deny-all is service_role. Imports of
// supabaseAdmin MUST be inside this .server.ts file (not at module scope)
// so it never ships to the client bundle.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsageRecord } from "@/lib/ai/types";

/**
 * The supabase client passed in MUST be the service-role client
 * (src/integrations/supabase/client.server.ts → supabaseAdmin). RLS denies
 * INSERT to all non-service_role.
 */
export async function recordUsage(
  supabaseAdmin: SupabaseClient,
  record: UsageRecord,
): Promise<void> {
  const { error } = await supabaseAdmin.from("ai_usage_log").insert({
    principal_id: record.principalId,
    capability: record.capability,
    model: record.model,
    prompt_version: record.promptVersion,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    latency_ms: record.latencyMs,
    estimated_cost_usd: record.estimatedCostUsd,
    success: record.success,
    error_kind: record.errorKind,
  });

  if (error) {
    // Don't fail the user-visible generation because the usage log failed —
    // log loudly server-side so it surfaces in Mission Control later.
    console.error("[ai_usage_log] insert failed", {
      capability: record.capability,
      success: record.success,
      error_kind: record.errorKind,
      error: error.message,
    });
  }
}
