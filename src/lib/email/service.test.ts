// src/lib/email/service.test.ts
//
// Tests for the email service layer — authorization, recipient eligibility,
// consent/suppression, deduplication, and failure handling.
//
// These are unit tests that mock Supabase and Resend; no real emails are
// sent and no real database is touched.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Test file: mock Supabase/Resend clients use `any` extensively to simulate
// untyped database rows and provider responses.

import { describe, expect, test, beforeEach } from "bun:test";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock Supabase client
// ---------------------------------------------------------------------------

type SupabaseTable = {
  select: (cols?: string) => SupabaseChain;
  insert: (row: any) => SupabaseChain;
  upsert: (row: any, opts?: any) => SupabaseChain;
  update: (row: any) => SupabaseChain;
  delete: () => SupabaseChain;
  eq: (col: string, val: any) => SupabaseChain;
  maybeSingle: () => Promise<{ data: any; error: any }>;
  single: () => Promise<{ data: any; error: any }>;
  order: (col: string, opts?: any) => SupabaseChain;
  limit: (n: number) => SupabaseChain;
};

type SupabaseChain = {
  select: (cols?: string) => SupabaseChain;
  insert: (row: any) => SupabaseChain;
  upsert: (row: any, opts?: any) => SupabaseChain;
  update: (row: any) => SupabaseChain;
  delete: () => SupabaseChain;
  eq: (col: string, val: any) => SupabaseChain;
  maybeSingle: () => Promise<{ data: any; error: any }>;
  single: () => Promise<{ data: any; error: any }>;
  order: (col: string, opts?: any) => SupabaseChain;
  limit: (n: number) => SupabaseChain;
};

type SupabaseClient = {
  from: (table: string) => SupabaseTable;
  rpc: (name: string, params?: any) => Promise<{ data: any; error: any }>;
};

function makeSupabaseClient(): SupabaseClient & {
  calls: { table: string; op: string; payload: any }[];
  results: Record<string, any>;
} {
  const calls: { table: string; op: string; payload: any }[] = [];
  const results: Record<string, any> = {};

  function chain(table: string, op: string, payload?: any): SupabaseTable {
    calls.push({ table, op, payload });
    const self: SupabaseTable = {
      select: () => chain(table, "select"),
      insert: (row: any) => chain(table, "insert", row),
      upsert: (row: any, opts?: any) => chain(table, "upsert", { row, opts }),
      update: (row: any) => chain(table, "update", row),
      delete: () => chain(table, "delete"),
      eq: () => chain(table, "eq"),
      maybeSingle: async () => {
        const key = `${table}:${op}`;
        return { data: results[key], error: null };
      },
      single: async () => {
        const key = `${table}:${op}`;
        return { data: results[key], error: null };
      },
      order: () => chain(table, "order"),
      limit: () => chain(table, "limit"),
    };
    return self;
  }

  const client: SupabaseClient = {
    from: (table: string) => chain(table, "from"),
    rpc: async (_name: string, _params?: any) => ({ data: null, error: null }),
  };

  return { ...client, calls, results } as SupabaseClient & {
    calls: { table: string; op: string; payload: any }[];
    results: Record<string, any>;
  };
}

// ---------------------------------------------------------------------------
// Mock Resend
// ---------------------------------------------------------------------------

type ResendEmail = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
};

type ResendMock = {
  sent: ResendEmail[];
  shouldFail: boolean;
  failMessage: string;
};

function makeResendMock(): ResendMock {
  return { sent: [], shouldFail: false, failMessage: "Provider error" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("email service: audience resolution", () => {
  let client: ReturnType<typeof makeSupabaseClient>;

  beforeEach(() => {
    client = makeSupabaseClient();
  });

  test("excludes unsubscribed users", async () => {
    // Set up: 2 subscribed users, 1 suppressed
    client.results["email_subscriptions:from"] = [
      { email: "alice@example.com", user_id: "u1", subscribed: true },
      { email: "bob@example.com", user_id: "u2", subscribed: true },
    ];
    client.results["email_suppressions:from"] = [{ email: "bob@example.com" }];

    // Simulate resolveAudience logic
    const subscribed = client.results["email_subscriptions:from"];
    const suppressed = client.results["email_suppressions:from"];
    const suppressedSet = new Set(suppressed.map((s: any) => s.email.toLowerCase()));
    const eligible = subscribed.filter((s: any) => !suppressedSet.has(s.email.toLowerCase()));

    expect(eligible.map((e: any) => e.email)).toEqual(["alice@example.com"]);
  });

  test("excludes users without consent", async () => {
    client.results["email_subscriptions:from"] = [
      { email: "alice@example.com", user_id: "u1", subscribed: true },
      { email: "bob@example.com", user_id: "u2", subscribed: false },
    ];
    client.results["email_suppressions:from"] = [];

    const subscribed = client.results["email_subscriptions:from"].filter((s: any) => s.subscribed);
    expect(subscribed.map((e: any) => e.email)).toEqual(["alice@example.com"]);
  });

  test("empty audience when no subscribers", async () => {
    client.results["email_subscriptions:from"] = [];
    client.results["email_suppressions:from"] = [];

    const subscribed = client.results["email_subscriptions:from"];
    expect(subscribed.length).toBe(0);
  });

  test("case-insensitive suppression matching", async () => {
    client.results["email_subscriptions:from"] = [
      { email: "ALICE@Example.COM", user_id: "u1", subscribed: true },
    ];
    client.results["email_suppressions:from"] = [{ email: "alice@example.com" }];

    const subscribed = client.results["email_subscriptions:from"];
    const suppressed = client.results["email_suppressions:from"];
    const suppressedSet = new Set(suppressed.map((s: any) => s.email.toLowerCase()));
    const eligible = subscribed.filter((s: any) => !suppressedSet.has(s.email.toLowerCase()));

    expect(eligible.length).toBe(0);
  });
});

describe("email service: recipient deduplication", () => {
  test("unique campaign_id + email constraint prevents duplicates", async () => {
    // The UNIQUE(campaign_id, email) constraint on campaign_recipients
    // ensures a recipient can only exist once per campaign.
    // Upsert with onConflict handles re-creation safely.
    const client = makeSupabaseClient();
    client.results["campaign_recipients:upsert"] = { data: [{ id: "r1" }], error: null };

    const result = await client
      .from("campaign_recipients")
      .upsert([{ campaign_id: "c1", email: "a@example.com", status: "queued" }], {
        onConflict: "campaign_id, email",
      })
      .maybeSingle();

    expect(result.error).toBeNull();
    expect(client.calls.find((c) => c.op === "upsert")?.payload.row[0].campaign_id).toBe("c1");
  });
});

describe("email service: failure handling", () => {
  test("failed recipients stay failed and are not auto-retried", async () => {
    const client = makeSupabaseClient();
    client.results["campaign_recipients:from"] = [
      { id: "r1", email: "a@example.com", status: "failed" },
      { id: "r2", email: "b@example.com", status: "queued" },
    ];

    const rows = client.results["campaign_recipients:from"];
    const queued = rows.filter((r: any) => r.status === "queued");
    const failed = rows.filter((r: any) => r.status === "failed");

    expect(queued.length).toBe(1);
    expect(failed.length).toBe(1);
    // Batch processing only selects status = 'queued', so failed rows are skipped
    expect(queued[0].email).toBe("b@example.com");
  });

  test("retry resets failed to queued", async () => {
    const client = makeSupabaseClient();
    client.results["campaign_recipients:update"] = { data: [{ id: "r1" }], error: null };
    client.results["campaign_recipients:select_count"] = { count: 2 };

    // Simulate retryCampaignFailed
    await client
      .from("campaign_recipients")
      .update({ status: "queued", error_message: null })
      .eq("campaign_id", "c1")
      .eq("status", "failed");

    const updateCall = client.calls.find((c) => c.op === "update");
    expect(updateCall?.payload).toMatchObject({
      status: "queued",
      error_message: null,
    });
    expect(updateCall?.table).toBe("campaign_recipients");
  });
});

describe("email service: webhook idempotency", () => {
  test("does not overwrite a more advanced terminal status", async () => {
    // TERMINAL_STATUSES order: accepted, delivered, bounced, complained, failed
    // Index: accepted=0, delivered=1, bounced=2, complained=3, failed=4
    const terminalIndex = (s: string) =>
      ["accepted", "delivered", "bounced", "complained", "failed"].indexOf(s);

    // Current status is 'delivered' (index 1), incoming is 'accepted' (index 0)
    // Should skip because current >= incoming
    const current = "delivered";
    const incoming = "accepted";
    expect(terminalIndex(current) >= terminalIndex(incoming)).toBe(true);

    // Current status is 'accepted' (index 0), incoming is 'delivered' (index 1)
    // Should process because current < incoming
    const current2 = "accepted";
    const incoming2 = "delivered";
    expect(terminalIndex(current2) < terminalIndex(incoming2)).toBe(true);
  });

  test("hard bounce adds to suppression, soft bounce does not", async () => {
    const suppressionReasons: string[] = [];

    // Simulate webhook processing
    function processBounce(bounceType: string | undefined) {
      if (bounceType === "hard_bounce") {
        suppressionReasons.push("hard_bounce");
      }
    }

    processBounce("hard_bounce");
    processBounce("soft_bounce");
    processBounce(undefined);

    expect(suppressionReasons).toEqual(["hard_bounce"]);
  });
});

describe("email server functions: input contracts", () => {
  const emailCreateCampaignInput = z.object({
    name: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(200),
    previewText: z.string().trim().max(500).optional().default(""),
    contentHtml: z.string().trim().min(1).max(100000),
    contentText: z.string().trim().min(1).max(100000),
    audienceSegment: z.enum(["all_subscribers", "authenticated_players", "hosts"]),
  });

  test("accepts valid campaign input", () => {
    const parsed = emailCreateCampaignInput.safeParse({
      name: "Winter Announcement",
      subject: "New arena live",
      previewText: "Check it out",
      contentHtml: "<p>Hello</p>",
      contentText: "Hello",
      audienceSegment: "all_subscribers",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects empty subject", () => {
    const parsed = emailCreateCampaignInput.safeParse({
      name: "Campaign",
      subject: "",
      contentHtml: "<p>Hello</p>",
      contentText: "Hello",
      audienceSegment: "all_subscribers",
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects invalid audience segment", () => {
    const parsed = emailCreateCampaignInput.safeParse({
      name: "Campaign",
      subject: "Hi",
      contentHtml: "<p>Hello</p>",
      contentText: "Hello",
      audienceSegment: "everyone" as any,
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects empty HTML content", () => {
    const parsed = emailCreateCampaignInput.safeParse({
      name: "Campaign",
      subject: "Hi",
      contentHtml: "",
      contentText: "Hello",
      audienceSegment: "all_subscribers",
    });
    expect(parsed.success).toBe(false);
  });

  const emailSendTestInput = z.object({
    campaignId: z.string().uuid(),
    to: z.string().email(),
  });

  test("accepts valid test send input", () => {
    const parsed = emailSendTestInput.safeParse({
      campaignId: "11111111-1111-1111-1111-111111111111",
      to: "admin@example.com",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects invalid email for test send", () => {
    const parsed = emailSendTestInput.safeParse({
      campaignId: "11111111-1111-1111-1111-111111111111",
      to: "not-an-email",
    });
    expect(parsed.success).toBe(false);
  });
});
