// src/lib/api/email.functions.ts
//
// Email & Communications server functions for Mission Control.
//
// Pattern mirrors src/lib/api/arena-admin.functions.ts:
//   createServerFn({ method: "POST" })
//     .middleware([requireSupabaseAuth])
//     .inputValidator(z.object(...))
//     .handler(async ({ data, context }) => { ... })
//
// Every handler:
//   1. Authenticates via requireSupabaseAuth (Bearer JWT).
//   2. Authorizes via public.is_admin() server-side.
//   3. Returns a typed envelope — never throws raw provider / PostgREST errors.
//
// The email service layer lives in src/lib/email/service.server.ts and is
// imported lazily inside handlers so the Resend SDK never reaches the client.
//
// The Resend webhook is handled by a raw route handler at
// src/routes/resend-webhook.ts (not a createServerFn), because webhooks
// require access to the raw request body for signature verification.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const uuid = z.string().uuid();
const email = z.string().email();
const nonEmpty = z.string().trim().min(1).max(200);

async function requireAdmin(context: {
  userId: string;
  supabase: any;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: allowed } = await context.supabase.rpc("is_admin");
  if (allowed !== true) {
    return { ok: false, error: "unauthorized" };
  }
  return { ok: true };
}

/* ---------------- Campaign CRUD ---------------- */

export const emailCreateCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      name: nonEmpty,
      subject: nonEmpty.max(200),
      previewText: z.string().trim().max(500).optional().default(""),
      contentHtml: z.string().trim().min(1).max(100000),
      contentText: z.string().trim().min(1).max(100000),
      audienceSegment: z.enum(["all_subscribers", "authenticated_players", "hosts"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCampaign } = await import("@/lib/email/service.server");

    const result = await createCampaign(supabaseAdmin, {
      name: data.name,
      subject: data.subject,
      previewText: data.previewText,
      contentHtml: data.contentHtml,
      contentText: data.contentText,
      audienceSegment: data.audienceSegment,
      createdBy: context.userId,
    });

    if (result.error) {
      console.error("[email/createCampaign] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return { ok: true as const, campaign: result.campaign };
  });

export const emailListCampaigns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({}))
  .handler(async ({ context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listCampaigns } = await import("@/lib/email/service.server");

    const result = await listCampaigns(supabaseAdmin);
    if (result.error) {
      console.error("[email/listCampaigns] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return { ok: true as const, campaigns: result.campaigns };
  });

export const emailGetCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ campaignId: uuid }))
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { getCampaign } = await import("@/lib/email/service.server");

    const result = await getCampaign(supabaseAdmin, data.campaignId);
    if (result.error || !result.campaign) {
      return { ok: false as const, error: "not_found" as const };
    }

    return { ok: true as const, campaign: result.campaign };
  });

export const emailUpdateCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      campaignId: uuid,
      name: nonEmpty.optional(),
      subject: nonEmpty.max(200).optional(),
      previewText: z.string().trim().max(500).optional(),
      contentHtml: z.string().trim().max(100000).optional(),
      contentText: z.string().trim().max(100000).optional(),
      audienceSegment: z.enum(["all_subscribers", "authenticated_players", "hosts"]).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { updateCampaign } = await import("@/lib/email/service.server");

    const result = await updateCampaign(supabaseAdmin, data.campaignId, {
      name: data.name,
      subject: data.subject,
      previewText: data.previewText,
      contentHtml: data.contentHtml,
      contentText: data.contentText,
      audienceSegment: data.audienceSegment,
    });

    if (result.error) {
      if (result.error.includes("not found")) {
        return { ok: false as const, error: "not_found" as const };
      }
      console.error("[email/updateCampaign] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return { ok: true as const, campaign: result.campaign };
  });

export const emailDeleteCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ campaignId: uuid }))
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { deleteCampaign } = await import("@/lib/email/service.server");

    const result = await deleteCampaign(supabaseAdmin, data.campaignId);
    if (result.error) {
      return {
        ok: false as const,
        error: result.error.includes("not found") ? "not_found" : "unknown",
      };
    }

    return { ok: true as const };
  });

/* ---------------- Audience resolution ---------------- */

export const emailResolveAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      audienceSegment: z.enum(["all_subscribers", "authenticated_players", "hosts"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveAudienceCount } = await import("@/lib/email/service.server");

    // Only the count is safe to expose to the client — never the email list.
    const result = await resolveAudienceCount(supabaseAdmin, data.audienceSegment);
    if (result.error) {
      console.error("[email/resolveAudience] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return {
      ok: true as const,
      eligibleCount: result.count,
      segment: data.audienceSegment,
    };
  });

/* ---------------- Send confirmation ---------------- */

export const emailConfirmSend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      campaignId: uuid,
      confirmedRecipientCount: z.number().int().min(0).max(100000),
    }),
  )
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      getCampaign,
      resolveAudience,
      createRecipientRows,
      processCampaignBatch,
      missingResendConfig,
    } = await import("@/lib/email/service.server");

    // Configuration check — surface actionable error without exposing secrets.
    const missing = missingResendConfig();
    if (missing.length > 0) {
      return {
        ok: false as const,
        error: "configuration",
        missing,
      };
    }

    // Fetch campaign.
    const campaignResult = await getCampaign(supabaseAdmin, data.campaignId);
    if (campaignResult.error || !campaignResult.campaign) {
      return { ok: false as const, error: "not_found" as const };
    }
    const campaign = campaignResult.campaign as {
      status: string;
      audience_segment: string;
    };

    if (campaign.status !== "draft") {
      return { ok: false as const, error: "campaign_not_draft" as const };
    }

    // Resolve audience again to verify the confirmed count matches.
    // This re-checks consent and suppressions at send time.
    const audience = await resolveAudience(supabaseAdmin, campaign.audience_segment as any);

    if (audience.eligible_count !== data.confirmedRecipientCount) {
      return {
        ok: false as const,
        error: "count_mismatch",
        expected: audience.eligible_count,
      };
    }

    // Create recipient rows (server-only email list, never returned to client).
    const created = await createRecipientRows(supabaseAdmin, data.campaignId, audience.emails);
    if (created.error) {
      console.error("[email/confirmSend] create recipients failed", {
        userId: context.userId,
        error: created.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    // Update campaign status to sending.
    const { error: updErr } = await (supabaseAdmin as any)
      .from("campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", data.campaignId);

    if (updErr) {
      console.error("[email/confirmSend] update status failed", {
        userId: context.userId,
        error: updErr.message,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    // Process the first batch immediately.
    const batch = await processCampaignBatch(supabaseAdmin, data.campaignId);
    if (batch.error) {
      console.error("[email/confirmSend] first batch failed", {
        userId: context.userId,
        error: batch.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return {
      ok: true as const,
      recipientCount: audience.eligible_count,
      processedInFirstBatch: batch.processed,
      queuedRemaining: batch.queuedRemaining,
    };
  });

/* ---------------- Process batch (for resuming / polling) ---------------- */

export const emailProcessBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ campaignId: uuid }))
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { processCampaignBatch } = await import("@/lib/email/service.server");

    const result = await processCampaignBatch(supabaseAdmin, data.campaignId);
    if (result.error) {
      console.error("[email/processBatch] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return {
      ok: true as const,
      processed: result.processed,
      queuedRemaining: result.queuedRemaining,
      accepted: result.accepted,
      failed: result.failed,
    };
  });

/* ---------------- Test send ---------------- */

export const emailSendTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      campaignId: uuid,
      to: email,
    }),
  )
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { missingResendConfig } = await import("@/lib/email/service.server");
    const missing = missingResendConfig();
    if (missing.length > 0) {
      return { ok: false as const, error: "configuration", missing };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sendTestEmail } = await import("@/lib/email/service.server");

    const result = await sendTestEmail(supabaseAdmin, data.campaignId, data.to);
    if (result.error) {
      console.error("[email/sendTest] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return { ok: true as const, messageId: result.messageId };
  });

/* ---------------- Retry failed recipients ---------------- */

export const emailRetryFailed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ campaignId: uuid }))
  .handler(async ({ data, context }) => {
    const adminCheck = await requireAdmin(context as { userId: string; supabase: any });
    if (!adminCheck.ok) {
      return { ok: false as const, error: "unauthorized" as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { retryCampaignFailed } = await import("@/lib/email/service.server");

    const result = await retryCampaignFailed(supabaseAdmin, data.campaignId);
    if (result.error) {
      console.error("[email/retryFailed] failed", {
        userId: context.userId,
        error: result.error,
      });
      return { ok: false as const, error: "unknown" as const };
    }

    return { ok: true as const, retried: result.retried };
  });
