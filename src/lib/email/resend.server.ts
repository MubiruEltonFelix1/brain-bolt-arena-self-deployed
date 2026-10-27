// src/lib/email/resend.server.ts
//
// Server-only Resend client. This module is safe to import only inside
// server-side handlers (.server.ts modules or createServerFn handlers).
// A top-level import from a route file would ship the Resend SDK to the
// client bundle — never do that.
//
// Environment variables are read per-request inside functions, never at
// module scope (Cloudflare Workers bind env at request time).

import { Resend } from "resend";

let _resend: Resend | undefined;

/**
 * Lazily create the Resend client. Reads RESEND_API_KEY from process.env
 * on first use so it resolves at request time on Cloudflare Workers.
 */
export function getResendClient(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "RESEND_API_KEY is not configured. Set it in your server environment before sending email.",
      );
    }
    _resend = new Resend(apiKey);
  }
  return _resend;
}

/**
 * Verified sender address used for all campaign and test-send emails.
 * Must be a domain verified in Resend before production sending.
 */
export function getResendFromEmail(): string {
  const from = process.env.RESEND_FROM_EMAIL;
  if (!from) {
    throw new Error(
      "RESEND_FROM_EMAIL is not configured. Set a verified sender address before sending email.",
    );
  }
  return from;
}

/**
 * Resend webhook signing secret. Used to verify webhook signatures.
 */
export function getResendWebhookSecret(): string {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "RESEND_WEBHOOK_SECRET is not configured. Set it to verify Resend webhook signatures.",
    );
  }
  return secret;
}

/**
 * Required email configuration present? Returns the missing variable names,
 * or an empty array when everything is set. Used to surface actionable
 * configuration errors without exposing secrets.
 */
export function missingResendConfig(): string[] {
  const missing: string[] = [];
  if (!process.env.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!process.env.RESEND_FROM_EMAIL) missing.push("RESEND_FROM_EMAIL");
  if (!process.env.RESEND_WEBHOOK_SECRET) missing.push("RESEND_WEBHOOK_SECRET");
  return missing;
}
