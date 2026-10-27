// src/routes/resend-webhook.ts
//
// Raw HTTP route handler for Resend webhooks.
// This is a standalone route (not a createServerFn) because webhook
// signature verification requires access to the raw request body.
//
// Resend webhook signature verification:
//   - Resend sends a `Resend-Signature` header: `t=timestamp,s1=signature`
//   - Signature = HMAC-SHA256(webhook_secret, timestamp + "." + raw_body)
//   - We recompute and compare using constant-time comparison.
//
// Routes here are handled by TanStack Start's server layer. The handler
// receives the raw Request and returns a Response.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";

import { getResendWebhookSecret } from "@/lib/email/resend.server";
import { processWebhookEvent } from "@/lib/email/service.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Resend signs webhook payloads with HMAC-SHA256 using the webhook secret.
// The signature header format is: t=timestamp,s1=hex_signature
function parseSignature(header: string | null): {
  timestamp: number;
  signature: string;
} | null {
  if (!header) return null;
  const parts = header.split(",");
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = Number(value);
    if (key === "s1") signature = value;
  }
  if (timestamp == null || !signature) return null;
  return { timestamp, signature };
}

function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export const POST = async (): Promise<Response> => {
  // Reject missing configuration without exposing secrets.
  const secret = getResendWebhookSecret();

  const request = getRequest();
  if (!request) {
    return new Response("Unauthorized", { status: 401 });
  }

  const signatureHeader = request.headers.get("resend-signature");
  const parsed = parseSignature(signatureHeader);
  if (!parsed) {
    return new Response("Invalid signature header", { status: 401 });
  }

  // Tolerance: reject signatures older than 5 minutes to prevent replay.
  const now = Math.floor(Date.now() / 1000);
  if (now - parsed.timestamp > 300) {
    return new Response("Signature timestamp too old", { status: 401 });
  }

  // Read the raw body for signature verification.
  const body = await request.text();
  const expected = computeSignature(secret, parsed.timestamp, body);

  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Parse the event payload.
  // `data` is `any` because JSON.parse returns unknown; the service layer
  // validates the structure before processing.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let event: { type: string; data: any };
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  // Process the webhook event (idempotent via service layer).
  const { error } = await processWebhookEvent(
    supabaseAdmin,
    event as import("@/lib/email/service.server").WebhookEvent,
  );

  if (error) {
    console.error("[resend-webhook] event processing failed", {
      type: event.type,
      error,
    });
    // Still return 200 so Resend doesn't retry on processing errors.
    // Processing failures are logged for investigation.
    return new Response("Accepted", { status: 200 });
  }

  return new Response("Accepted", { status: 200 });
};
