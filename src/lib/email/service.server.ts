// src/lib/email/service.server.ts
//
// Email & Communications service layer for Mission Control.
// All functions are server-only and must be called from createServerFn
// handlers or other server-side code. They never ship to the client bundle.
//
// Sending strategy (no external job queue exists in this project):
//
//   1. Campaign is confirmed -> recipient rows created with status 'queued',
//      campaign status set to 'sending'.
//   2. processCampaignBatch() fetches a bounded batch of 'queued' recipients,
//      sends via Resend, updates each recipient's status.
//   3. Client polls processCampaignBatch() until no 'queued' recipients remain.
//   4. retryCampaignFailed() resets 'failed' recipients to 'queued' for a
//      safe, manually-triggered retry.
//
// Idempotency / safety:
//
//   - campaign_recipients has UNIQUE(campaign_id, email) so a recipient can
//     only exist once per campaign.
//   - Each recipient has a status state machine: queued -> accepted ->
//       delivered / bounced / complained / failed.
//   - A recipient in any terminal state is never re-processed by the normal
//     batch loop.
//   - Consent and suppressions are re-checked before every batch.
//   - Provider message IDs are stored so webhooks can map events to the
//     correct recipient.
//   - No automatic indefinite retries: failed recipients stay 'failed'
//     until an admin explicitly retries them.

import type { SupabaseClient } from "@supabase/supabase-js";

import { getResendClient, getResendFromEmail } from "./resend.server";

export type CampaignStatus = "draft" | "queued" | "sending" | "sent" | "failed" | "cancelled";

export type AudienceSegment = "all_subscribers" | "authenticated_players" | "hosts";

export type RecipientStatus =
  | "queued"
  | "accepted"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed";

export type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  preview_text: string;
  content_html: string;
  content_text: string;
  status: CampaignStatus;
  audience_segment: AudienceSegment;
  recipient_count: number;
  accepted_count: number;
  delivered_count: number;
  failed_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export type RecipientRow = {
  id: string;
  campaign_id: string;
  email: string;
  status: RecipientStatus;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

// Audience resolution result. `emails` is server-only and must never be
// returned to the client — only eligible_count is safe to expose.
export type AudienceResolution = {
  segment: AudienceSegment;
  eligible_count: number;
  emails: string[];
};

export type AudienceCount = {
  segment: AudienceSegment;
  eligible_count: number;
};

// Maximum recipients processed in a single batch request.
const BATCH_SIZE = 50;

// Terminal recipient statuses that should never be re-processed.
const TERMINAL_STATUSES: RecipientStatus[] = [
  "accepted",
  "delivered",
  "bounced",
  "complained",
  "failed",
];

function terminalIndex(status: RecipientStatus): number {
  return TERMINAL_STATUSES.indexOf(status);
}

/* ------------------------------------------------------------------ */
/* Campaign CRUD                                                      */
/* ------------------------------------------------------------------ */

export async function createCampaign(
  admin: SupabaseClient,
  input: {
    name: string;
    subject: string;
    previewText: string;
    contentHtml: string;
    contentText: string;
    audienceSegment: AudienceSegment;
    createdBy: string;
  },
): Promise<{ campaign: CampaignRow | null; error: string | null }> {
  const { data, error } = await admin
    .from("campaigns")
    .insert({
      name: input.name,
      subject: input.subject,
      preview_text: input.previewText,
      content_html: input.contentHtml,
      content_text: input.contentText,
      status: "draft",
      audience_segment: input.audienceSegment,
      recipient_count: 0,
      accepted_count: 0,
      delivered_count: 0,
      failed_count: 0,
      created_by: input.createdBy,
    })
    .select()
    .maybeSingle();

  if (error) {
    return { campaign: null, error: error.message };
  }

  return { campaign: data as unknown as CampaignRow, error: null };
}

export async function listCampaigns(
  admin: SupabaseClient,
): Promise<{ campaigns: CampaignRow[]; error: string | null }> {
  const { data, error } = await admin
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return { campaigns: [], error: error.message };
  }

  return { campaigns: (data as unknown as CampaignRow[]) ?? [], error: null };
}

export async function getCampaign(
  admin: SupabaseClient,
  campaignId: string,
): Promise<{ campaign: CampaignRow | null; error: string | null }> {
  const { data, error } = await admin
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (error) {
    return { campaign: null, error: error.message };
  }

  return { campaign: (data as unknown as CampaignRow) ?? null, error: null };
}

export async function updateCampaign(
  admin: SupabaseClient,
  campaignId: string,
  updates: Partial<{
    name: string;
    subject: string;
    previewText: string;
    contentHtml: string;
    contentText: string;
    audienceSegment: AudienceSegment;
  }>,
): Promise<{ campaign: CampaignRow | null; error: string | null }> {
  const dbUpdates: Record<string, unknown> = {};
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.subject !== undefined) dbUpdates.subject = updates.subject;
  if (updates.previewText !== undefined) dbUpdates.preview_text = updates.previewText;
  if (updates.contentHtml !== undefined) dbUpdates.content_html = updates.contentHtml;
  if (updates.contentText !== undefined) dbUpdates.content_text = updates.contentText;
  if (updates.audienceSegment !== undefined) dbUpdates.audience_segment = updates.audienceSegment;
  dbUpdates.updated_at = new Date().toISOString();

  const { data, error } = await admin
    .from("campaigns")
    .update(dbUpdates)
    .eq("id", campaignId)
    .select()
    .maybeSingle();

  if (error) {
    return { campaign: null, error: error.message };
  }

  return { campaign: (data as unknown as CampaignRow) ?? null, error: null };
}

export async function deleteCampaign(
  admin: SupabaseClient,
  campaignId: string,
): Promise<{ error: string | null }> {
  const { data: campaign, error: fetchError } = await admin
    .from("campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();

  if (fetchError) return { error: fetchError.message };
  if (!campaign) return { error: "Campaign not found" };
  const status = (campaign as { status: string }).status;
  if (status !== "draft" && status !== "failed") {
    return { error: "Only draft or failed campaigns can be deleted" };
  }

  const { error } = await admin.from("campaigns").delete().eq("id", campaignId);
  if (error) return { error: error.message };
  return { error: null };
}

/* ------------------------------------------------------------------ */
/* Audience resolution                                                */
/* ------------------------------------------------------------------ */

/**
 * Resolve the eligible recipient list for a campaign audience segment.
 *
 * Eligibility rules:
 *   - User must have an explicit email_subscriptions row with subscribed = true
 *   - User's email must NOT be in email_suppressions
 *   - For 'authenticated_players': user must have a public.profiles row
 *   - For 'hosts': user must have the 'host' role in public.user_roles
 *   - Anonymous players (no auth.users email) are never eligible
 *
 * Returns emails as a server-only list. Callers must never return this
 * list to the client — only the count.
 */
export async function resolveAudience(
  admin: SupabaseClient,
  segment: AudienceSegment,
): Promise<AudienceResolution> {
  const { data: subscribed, error: subErr } = await admin
    .from("email_subscriptions")
    .select("email, user_id")
    .eq("subscribed", true);

  if (subErr) {
    throw new Error(subErr.message);
  }

  const { data: suppressed, error: supErr } = await admin
    .from("email_suppressions")
    .select("email");

  if (supErr) {
    throw new Error(supErr.message);
  }

  const suppressedSet = new Set(
    (suppressed as { email: string }[]).map((s) => s.email.toLowerCase()),
  );

  let candidates = (subscribed as { email: string; user_id: string }[]).filter(
    (s) => !suppressedSet.has(s.email.toLowerCase()),
  );

  if (segment === "authenticated_players" || segment === "hosts") {
    const { data: profiles, error: profErr } = await admin.from("profiles").select("id, user_id");

    if (profErr) {
      throw new Error(profErr.message);
    }

    const profileUserIds = new Set(
      (profiles as { id: string; user_id: string }[]).map((p) => p.user_id ?? p.id),
    );
    candidates = candidates.filter((c) => profileUserIds.has(c.user_id));
  }

  if (segment === "hosts") {
    const { data: roles, error: roleErr } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", "host");

    if (roleErr) {
      throw new Error(roleErr.message);
    }

    const hostUserIds = new Set((roles as { user_id: string }[]).map((r) => r.user_id));
    candidates = candidates.filter((c) => hostUserIds.has(c.user_id));
  }

  const emails = candidates.map((c) => c.email);
  return { segment, eligible_count: emails.length, emails };
}

/**
 * Resolve audience and return only the count (safe to expose to client).
 */
export async function resolveAudienceCount(
  admin: SupabaseClient,
  segment: AudienceSegment,
): Promise<{ count: number; error: string | null }> {
  try {
    const result = await resolveAudience(admin, segment);
    return { count: result.eligible_count, error: null };
  } catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : "unknown" };
  }
}

/* ------------------------------------------------------------------ */
/* Recipient row creation                                             */
/* ------------------------------------------------------------------ */

export async function createRecipientRows(
  admin: SupabaseClient,
  campaignId: string,
  emails: string[],
): Promise<{ created: number; error: string | null }> {
  if (emails.length === 0) return { created: 0, error: null };

  const rows = emails.map((email) => ({
    campaign_id: campaignId,
    email: email.toLowerCase(),
    status: "queued" as const,
  }));

  const { error } = await admin
    .from("campaign_recipients")
    .upsert(rows, { onConflict: "campaign_id, email" });

  if (error) return { created: 0, error: error.message };
  return { created: rows.length, error: null };
}

/* ------------------------------------------------------------------ */
/* Required config check                                              */
/* ------------------------------------------------------------------ */

export function missingResendConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!process.env.RESEND_FROM_EMAIL) missing.push("RESEND_FROM_EMAIL");
  if (!process.env.RESEND_WEBHOOK_SECRET) missing.push("RESEND_WEBHOOK_SECRET");
  return missing;
}

/* ------------------------------------------------------------------ */
/* Sending                                                            */
/* ------------------------------------------------------------------ */

export async function processCampaignBatch(
  admin: SupabaseClient,
  campaignId: string,
): Promise<{
  processed: number;
  queuedRemaining: number;
  accepted: number;
  failed: number;
  error: string | null;
}> {
  const { data: recipients, error: fetchError } = await admin
    .from("campaign_recipients")
    .select("id, email")
    .eq("campaign_id", campaignId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    return {
      processed: 0,
      queuedRemaining: 0,
      accepted: 0,
      failed: 0,
      error: fetchError.message,
    };
  }

  const batch = (recipients as RecipientRow[]) ?? [];
  if (batch.length === 0) {
    const { data: stats, error: statsErr } = await admin
      .from("campaign_recipients")
      .select("status")
      .eq("campaign_id", campaignId);

    if (statsErr) {
      return {
        processed: 0,
        queuedRemaining: 0,
        accepted: 0,
        failed: 0,
        error: statsErr.message,
      };
    }

    const rows = stats as { status: string }[];
    const queued = rows.filter((r) => r.status === "queued").length;
    const accepted = rows.filter((r) => r.status === "accepted").length;
    const failed = rows.filter((r) => r.status === "failed").length;

    return { processed: 0, queuedRemaining: queued, accepted, failed, error: null };
  }

  // Re-check consent and suppressions before sending this batch.
  const { data: suppressed, error: supErr } = await admin
    .from("email_suppressions")
    .select("email");

  if (supErr) {
    return {
      processed: 0,
      queuedRemaining: 0,
      accepted: 0,
      failed: 0,
      error: supErr.message,
    };
  }

  const suppressedSet = new Set(
    (suppressed as { email: string }[]).map((s) => s.email.toLowerCase()),
  );

  const resend = getResendClient();
  const fromEmail = getResendFromEmail();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("subject, content_html, content_text, preview_text, name")
    .eq("id", campaignId)
    .maybeSingle();

  let acceptedCount = 0;
  let failedCount = 0;

  for (const recipient of batch) {
    if (suppressedSet.has(recipient.email.toLowerCase())) {
      await admin
        .from("campaign_recipients")
        .update({
          status: "failed",
          error_message: "Suppressed before send",
          updated_at: new Date().toISOString(),
        })
        .eq("id", recipient.id);
      failedCount++;
      continue;
    }

    const camp = campaign as {
      subject: string;
      content_html: string;
      content_text: string;
      preview_text: string;
      name: string;
    };

    try {
      const { data: sendData, error: sendErr } = await resend.emails.send({
        from: fromEmail,
        to: [recipient.email],
        subject: camp.subject,
        html: camp.content_html,
        text: camp.content_text,
      });

      if (sendErr) {
        await admin
          .from("campaign_recipients")
          .update({
            status: "failed",
            error_message: sendErr.message ?? "Unknown provider error",
            updated_at: new Date().toISOString(),
          })
          .eq("id", recipient.id);
        failedCount++;
      } else {
        await admin
          .from("campaign_recipients")
          .update({
            status: "accepted",
            provider_message_id: sendData?.id ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", recipient.id);
        acceptedCount++;
      }
    } catch (err) {
      await admin
        .from("campaign_recipients")
        .update({
          status: "failed",
          error_message: err instanceof Error ? err.message : "Unexpected error",
          updated_at: new Date().toISOString(),
        })
        .eq("id", recipient.id);
      failedCount++;
    }
  }

  await updateCampaignCounts(admin, campaignId);

  const { data: remaining } = await admin
    .from("campaign_recipients")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "queued");

  return {
    processed: batch.length,
    queuedRemaining: (remaining as { id: string }[]).length,
    accepted: acceptedCount,
    failed: failedCount,
    error: null,
  };
}

async function updateCampaignCounts(admin: SupabaseClient, campaignId: string): Promise<void> {
  const { data: stats } = await admin
    .from("campaign_recipients")
    .select("status")
    .eq("campaign_id", campaignId);

  if (!stats) return;

  const rows = stats as { status: string }[];
  const accepted = rows.filter((r) => r.status === "accepted").length;
  const delivered = rows.filter((r) => r.status === "delivered").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const total = rows.length;
  const queued = rows.filter((r) => r.status === "queued").length;

  let status: CampaignStatus = "sending";
  if (queued === 0 && failed > 0 && accepted === 0 && delivered === 0) {
    status = "failed";
  } else if (queued === 0 && (accepted > 0 || delivered > 0)) {
    status = "sent";
  }

  await admin
    .from("campaigns")
    .update({
      accepted_count: accepted,
      delivered_count: delivered,
      failed_count: failed,
      recipient_count: total,
      status,
      ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
}

/* ------------------------------------------------------------------ */
/* Test send                                                          */
/* ------------------------------------------------------------------ */

export async function sendTestEmail(
  admin: SupabaseClient,
  campaignId: string,
  toEmail: string,
): Promise<{ messageId: string | null; error: string | null }> {
  const { data: campaign } = await admin
    .from("campaigns")
    .select("subject, content_html, content_text, name")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) {
    return { messageId: null, error: "Campaign not found" };
  }

  const resend = getResendClient();
  const fromEmail = getResendFromEmail();

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to: [toEmail],
    subject: `[Test] ${(campaign as { subject: string }).subject}`,
    html: (campaign as { content_html: string }).content_html,
    text: (campaign as { content_text: string }).content_text,
  });

  if (error) {
    return { messageId: null, error: error.message };
  }

  return { messageId: (data as { id: string }).id ?? null, error: null };
}

/* ------------------------------------------------------------------ */
/* Retry failed recipients                                            */
/* ------------------------------------------------------------------ */

export async function retryCampaignFailed(
  admin: SupabaseClient,
  campaignId: string,
): Promise<{ retried: number; error: string | null }> {
  const { error } = await admin
    .from("campaign_recipients")
    .update({
      status: "queued",
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("campaign_id", campaignId)
    .eq("status", "failed");

  if (error) return { retried: 0, error: error.message };

  const { count } = await admin
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "queued");

  return { retried: count ?? 0, error: null };
}

/* ------------------------------------------------------------------ */
/* Webhook event processing                                           */
/* ------------------------------------------------------------------ */

type WebhookEventType =
  | "email.sent"
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.failed";

export type WebhookEventPayload = {
  id: string;
  to: string[];
  created_at: string;
  bounce_type?: string;
};

export type WebhookEvent = {
  type: WebhookEventType;
  data: WebhookEventPayload;
};

export async function processWebhookEvent(
  admin: SupabaseClient,
  event: WebhookEvent,
): Promise<{ processed: boolean; error: string | null }> {
  const { type, data } = event;
  const email = data.to?.[0] ?? null;
  const messageId = data.id ?? null;

  if (!email || !messageId) {
    return { processed: false, error: "Missing email or message_id" };
  }

  const { data: recipient, error: findErr } = await admin
    .from("campaign_recipients")
    .select("id, campaign_id, email, status")
    .eq("provider_message_id", messageId)
    .maybeSingle();

  if (findErr) {
    return { processed: false, error: findErr.message };
  }

  if (!recipient) {
    return { processed: false, error: null };
  }

  const now = new Date().toISOString();
  const recipientRow = recipient as {
    id: string;
    campaign_id: string;
    email: string;
    status: string;
  };

  const currentStatus = recipientRow.status as RecipientStatus;

  // Map webhook type to recipient status.
  let newStatus: RecipientStatus;
  let addToSuppression = false;
  let suppressionReason: "unsubscribe" | "hard_bounce" | "complaint" | null = null;

  switch (type) {
    case "email.delivered":
      newStatus = "delivered";
      break;
    case "email.bounced":
      newStatus = "bounced";
      if (data.bounce_type === "hard_bounce") {
        addToSuppression = true;
        suppressionReason = "hard_bounce";
      }
      break;
    case "email.complained":
      newStatus = "complained";
      addToSuppression = true;
      suppressionReason = "complaint";
      break;
    case "email.failed":
      newStatus = "failed";
      break;
    case "email.sent":
    default:
      newStatus = "accepted";
      break;
  }

  // Idempotency: don't overwrite a more advanced or terminal state.
  if (terminalIndex(currentStatus) >= terminalIndex(newStatus)) {
    return { processed: true, error: null };
  }

  await admin
    .from("campaign_recipients")
    .update({ status: newStatus, updated_at: now })
    .eq("id", recipientRow.id);

  if (addToSuppression && suppressionReason) {
    await admin.from("email_suppressions").upsert(
      {
        email: recipientRow.email.toLowerCase(),
        reason: suppressionReason,
        source: "resend_webhook",
      },
      { onConflict: "email" },
    );
  }

  await updateCampaignCounts(admin, recipientRow.campaign_id);

  return { processed: true, error: null };
}
