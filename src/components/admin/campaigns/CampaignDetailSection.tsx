/* eslint-disable @typescript-eslint/no-explicit-any */
// Campaign data comes from untyped server-function envelopes; `any` is used
// consistently with the existing admin codebase (arena-admin.functions.ts).

// src/components/admin/campaigns/CampaignDetailSection.tsx
//
// Campaign detail view: composer, preview, audience selection, send
// controls, and delivery history. All mutations go through email server
// functions; recipient email addresses never reach the browser.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mail,
  Send,
  Eye,
  Edit2,
  Phone,
  MailOpen,
  Users,
  ShieldAlert,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import {
  emailGetCampaign,
  emailUpdateCampaign,
  emailResolveAudience,
  emailConfirmSend,
  emailSendTest,
  emailProcessBatch,
  emailRetryFailed,
  emailDeleteCampaign,
} from "@/lib/api/email.functions";
import { Skeleton } from "@/components/ui/skeleton";

type CampaignStatusBadge = {
  variant: "default" | "secondary" | "destructive" | "outline";
  label: string;
};

function statusBadge(status: string): CampaignStatusBadge {
  switch (status) {
    case "draft":
      return { variant: "outline", label: "Draft" };
    case "queued":
    case "sending":
      return { variant: "secondary", label: "Sending" };
    case "sent":
      return { variant: "default", label: "Sent" };
    case "failed":
      return { variant: "destructive", label: "Failed" };
    case "cancelled":
      return { variant: "outline", label: "Cancelled" };
    default:
      return { variant: "outline", label: status };
  }
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CampaignDetailSection({
  campaignId,
  onBack,
}: {
  campaignId: string;
  onBack: () => void;
}) {
  const [campaign, setCampaign] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [batchProgress, setBatchProgress] = useState<{
    processed: number;
    queuedRemaining: number;
    accepted: number;
    failed: number;
  } | null>(null);

  const resolveAudienceCount = useCallback(async () => {
    if (!campaign) return;
    setAudienceLoading(true);
    const result = await emailResolveAudience({
      data: { audienceSegment: campaign.audience_segment as any },
    });
    setAudienceLoading(false);
    if (result.ok) {
      setAudienceCount(result.eligibleCount);
    } else {
      setAudienceCount(null);
    }
  }, [campaign]);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    const result = await emailGetCampaign({ data: { campaignId } });
    if (!result.ok) {
      setError(result.error === "unauthorized" ? "Not authorized" : "Failed to load campaign");
      setLoading(false);
      return;
    }
    setCampaign(result.campaign);
    setLoading(false);
    // Resolve audience count for the campaign's segment
    void resolveAudienceCount();
  }, [campaignId, resolveAudienceCount]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpdate = useCallback(
    async (updates: any) => {
      if (!campaignId) return;
      const result = await emailUpdateCampaign({ data: { campaignId, ...updates } });
      if (!result.ok) {
        toastError(
          result.error === "unauthorized"
            ? new Error("Not authorized")
            : new Error("Failed to update campaign"),
        );
        return;
      }
      setCampaign(result.campaign);
      toast.success("Campaign updated");
    },
    [campaignId],
  );

  const handleConfirmSend = useCallback(async () => {
    if (!campaign || audienceCount === null) return;
    setSending(true);
    const result = await emailConfirmSend({
      data: {
        campaignId: campaign.id as string,
        confirmedRecipientCount: audienceCount,
      },
    });
    setSending(false);
    if (!result.ok) {
      if (result.error === "configuration") {
        toast.error("Email not configured", {
          description: `Missing: ${(result as any).missing?.join(", ")}`,
        });
      } else if (result.error === "count_mismatch") {
        toast.error("Audience count changed", {
          description: `Expected ${result.expected} recipients. Please refresh and confirm again.`,
        });
        void resolveAudienceCount();
      } else if (result.error === "unauthorized") {
        toastError(new Error("Not authorized"));
      } else {
        toastError(new Error("Failed to send campaign"));
      }
      return;
    }
    toast.success(`Campaign sending to ${result.recipientCount} recipients`);
    setCampaign((c: any) => ({ ...c, status: "sending" }));
    setBatchProgress({
      processed: result.processedInFirstBatch ?? 0,
      queuedRemaining: result.queuedRemaining ?? 0,
      accepted: 0,
      failed: 0,
    });
  }, [campaign, audienceCount, resolveAudienceCount]);

  const handleProcessBatch = useCallback(async () => {
    if (!campaignId) return;
    const result = await emailProcessBatch({ data: { campaignId } });
    if (!result.ok) {
      toastError(new Error("Failed to process batch"));
      return;
    }
    setBatchProgress({
      processed: result.processed,
      queuedRemaining: result.queuedRemaining,
      accepted: result.accepted,
      failed: result.failed,
    });
    // Refresh campaign to get updated counts
    void load();
  }, [campaignId, load]);

  const handleRetryFailed = useCallback(async () => {
    if (!campaignId) return;
    const result = await emailRetryFailed({ data: { campaignId } });
    if (!result.ok) {
      toastError(new Error("Failed to retry failed recipients"));
      return;
    }
    toast.success(`Reset ${result.retried} failed recipients to queued`);
    void load();
  }, [campaignId, load]);

  const handleTestSend = useCallback(async () => {
    if (!campaignId || !testEmail) return;
    setTestSending(true);
    const result = await emailSendTest({ data: { campaignId, to: testEmail } });
    setTestSending(false);
    if (!result.ok) {
      if (result.error === "configuration") {
        toast.error("Email not configured", {
          description: `Missing: ${(result as any).missing?.join(", ")}`,
        });
      } else {
        toastError(new Error("Failed to send test email"));
      }
      return;
    }
    toast.success(`Test email sent to ${testEmail}`);
    setTestEmail("");
  }, [campaignId, testEmail]);

  const handleDelete = useCallback(async () => {
    if (!campaignId) return;
    if (!confirm("Delete this campaign? This cannot be undone.")) return;
    const result = await emailDeleteCampaign({ data: { campaignId } });
    if (!result.ok) {
      toastError(new Error("Failed to delete campaign"));
      return;
    }
    toast.success("Campaign deleted");
  }, [campaignId]);

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader campaign={null as any} onBack={onBack} onDelete={handleDelete} />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-80" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <PageHeader campaign={null as any} onBack={onBack} onDelete={handleDelete} />
        <div className="border border-border bg-card p-6 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-pink-shock mb-3" />
          <h3 className="font-display text-xl italic uppercase mb-2">Unable to load campaign</h3>
          <p className="text-foreground/60 text-sm mb-4">{error}</p>
          <Button onClick={load} variant="default">
            Try again
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/admin?section=email";
            }}
          >
            Back to campaigns
          </Button>
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6">
        <PageHeader campaign={null as any} onBack={onBack} onDelete={handleDelete} />
        <div className="border border-border bg-card p-6 text-center">
          <p className="text-foreground/60 text-sm">Campaign not found</p>
        </div>
      </div>
    );
  }

  const badge = statusBadge(campaign.status);
  const canSend = campaign.status === "draft" && audienceCount !== null && audienceCount > 0;
  const canRetry = campaign.status === "failed";
  const canContinueSending = campaign.status === "sending";

  return (
    <div className="space-y-6 p-6">
      <PageHeader campaign={campaign} onBack={onBack} onDelete={handleDelete} />

      {/* Campaign header / status card */}
      <Card className="border border-border bg-card">
        <CardHeader className="p-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {campaign.status === "sending" && (
                <span className="font-mono text-[10px] uppercase text-volt animate-pulse">
                  Processing…
                </span>
              )}
            </div>
            <h2 className="font-display text-3xl italic uppercase mb-1">
              {campaign.name || campaign.subject}
            </h2>
            <p className="font-mono text-xs text-foreground/50 truncate max-w-md">
              {campaign.subject}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {canSend && (
              <Button
                onClick={handleConfirmSend}
                disabled={sending}
                className="bg-volt text-background font-display text-base px-5 py-3 skew-cta disabled:opacity-50 flex items-center gap-2"
              >
                <Send className="size-4" /> Confirm & Send
              </Button>
            )}
            {canRetry && (
              <Button
                onClick={handleRetryFailed}
                className="border border-pink-shock text-pink-shock px-4 py-3 font-mono text-xs uppercase hover:bg-pink-shock hover:text-background"
              >
                Retry failed
              </Button>
            )}
            {canContinueSending && (
              <Button
                onClick={handleProcessBatch}
                className="border border-border px-4 py-3 font-mono text-xs uppercase hover:border-volt hover:text-volt"
              >
                Process batch
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StatCard
              label="Recipients"
              value={campaign.recipient_count?.toLocaleString() ?? "0"}
            />
            <StatCard
              label="Accepted"
              value={campaign.accepted_count?.toLocaleString() ?? "0"}
              accent="volt"
            />
            <StatCard
              label="Delivered"
              value={campaign.delivered_count?.toLocaleString() ?? "0"}
              accent="cyan-jolt"
            />
            <StatCard
              label="Failed"
              value={campaign.failed_count?.toLocaleString() ?? "0"}
              accent="pink-shock"
            />
          </div>
          {batchProgress && (
            <div className="mt-4 p-4 bg-background/30 border border-border rounded-md">
              <div className="flex justify-between mb-1">
                <span className="font-mono text-[10px] uppercase text-foreground/50">
                  Batch progress
                </span>
                <span className="font-mono text-[10px] uppercase text-foreground/50">
                  {batchProgress.queuedRemaining} remaining
                </span>
              </div>
              <div className="h-2 bg-background rounded-full overflow-hidden">
                <div
                  className="h-full bg-volt"
                  style={{
                    width: campaign.recipient_count
                      ? Math.min(
                          100,
                          ((campaign.recipient_count - batchProgress.queuedRemaining) /
                            campaign.recipient_count) *
                            100,
                        )
                      : 0,
                  }}
                />
              </div>
              <div className="flex justify-between mt-1 text-[10px] font-mono uppercase text-foreground/50">
                <span>{batchProgress.accepted} accepted</span>
                <span>{batchProgress.failed} failed</span>
              </div>
            </div>
          )}
          <p className="mt-4 font-mono text-[10px] uppercase text-foreground/50">
            Created {formatDate(campaign.created_at)} ·
            {campaign.sent_at ? `Sent ${formatDate(campaign.sent_at)}` : "Not yet sent"}
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue="composer" className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="composer">Composer</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="audience">Audience</TabsTrigger>
          <TabsTrigger value="send">Send & Test</TabsTrigger>
        </TabsList>

        <TabsContent value="composer" className="w-full">
          <CampaignComposer campaign={campaign} onUpdate={handleUpdate} />
        </TabsContent>
        <TabsContent value="preview" className="w-full">
          <CampaignPreview campaign={campaign} />
        </TabsContent>
        <TabsContent value="audience" className="w-full">
          <AudienceCard
            segment={campaign.audience_segment}
            count={audienceCount}
            loading={audienceLoading}
            onRefresh={resolveAudienceCount}
          />
        </TabsContent>
        <TabsContent value="send" className="w-full">
          <SendCard
            campaign={campaign}
            canSend={canSend}
            audienceCount={audienceCount}
            onConfirmSend={handleConfirmSend}
            onTestSend={handleTestSend}
            testEmail={testEmail}
            setTestEmail={setTestEmail}
            testSending={testSending}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PageHeader({
  campaign,
  onBack,
  onDelete,
}: {
  campaign: any | null;
  onBack: () => void;
  onDelete: () => void;
}) {
  const title = campaign?.name || campaign?.subject || "Campaign";

  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <button
          onClick={onBack}
          className="font-mono text-xs uppercase text-foreground/50 hover:text-volt flex items-center gap-1"
        >
          ← Campaigns
        </button>
        <h2 className="font-display text-3xl italic uppercase mt-1">
          {title}
        </h2>
      </div>
      <Button variant="destructive" onClick={onDelete} className="text-xs px-3 py-2">
        Delete
      </Button>
    </div>
  );
}


function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "volt" | "cyan-jolt" | "pink-shock";
}) {
  const accentColors: Record<string, { bg: string; text: string }> = {
    volt: { bg: "bg-volt/10", text: "text-volt" },
    "cyan-jolt": { bg: "bg-cyan-jolt/10", text: "text-cyan-jolt" },
    "pink-shock": { bg: "bg-pink-shock/10", text: "text-pink-shock" },
  };
  const c = accentColors[accent ?? "volt"];
  return (
    <div className="border border-border bg-card p-4">
      <p className={`font-mono text-[10px] uppercase tracking-widest ${c.text}`}>{label}</p>
      <p className="mt-1 font-display text-2xl italic text-foreground">{value}</p>
    </div>
  );
}

function CampaignComposer({
  campaign,
  onUpdate,
}: {
  campaign: any;
  onUpdate: (updates: any) => void;
}) {
  const [name, setName] = useState(campaign.name || "");
  const [subject, setSubject] = useState(campaign.subject || "");
  const [previewText, setPreviewText] = useState(campaign.preview_text || "");
  const [contentHtml, setContentHtml] = useState(campaign.content_html || "");
  const [contentText, setContentText] = useState(campaign.content_text || "");
  const [dirty, setDirty] = useState(false);

  const handleSave = useCallback(async () => {
    await onUpdate({
      name,
      subject,
      previewText,
      contentHtml,
      contentText,
      audienceSegment: campaign.audience_segment,
    });
    setDirty(false);
  }, [onUpdate, name, subject, previewText, contentHtml, contentText, campaign.audience_segment]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-3">
          <Label>Campaign name</Label>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder="e.g. Winter 2026 announcement"
          />
        </div>
        <div className="space-y-3">
          <Label>Subject line</Label>
          <Input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setDirty(true);
            }}
            placeholder="e.g. New quiz arena now live"
          />
        </div>
      </div>
      <div className="space-y-3">
        <Label>Preview text</Label>
        <Textarea
          value={previewText}
          onChange={(e) => {
            setPreviewText(e.target.value);
            setDirty(true);
          }}
          placeholder="Short summary shown in inbox previews"
          className="h-24"
        />
        <p className="text-[10px] text-foreground/50 uppercase font-mono">
          Shown alongside the subject in email clients. Keep it short.
        </p>
      </div>
      <div className="space-y-3">
        <Label>HTML content</Label>
        <Textarea
          value={contentHtml}
          onChange={(e) => {
            setContentHtml(e.target.value);
            setDirty(true);
          }}
          placeholder="<p>Your announcement here</p>"
          className="h-64 font-mono text-xs"
        />
        <p className="text-[10px] text-foreground/50 uppercase font-mono">
          HTML email content. Avoid inline scripts and unsupported tags.
        </p>
      </div>
      <div className="space-y-3">
        <Label>Plain-text content</Label>
        <Textarea
          value={contentText}
          onChange={(e) => {
            setContentText(e.target.value);
            setDirty(true);
          }}
          placeholder="Your announcement here"
          className="h-48 font-mono text-xs"
        />
        <p className="text-[10px] text-foreground/50 uppercase font-mono">
          Fallback for email clients that don't render HTML.
        </p>
      </div>
      <div className="flex items-center gap-3 pt-4">
        <Button
          onClick={handleSave}
          disabled={!dirty}
          className="bg-volt text-background font-display text-base px-5 py-3 skew-cta disabled:opacity-50"
        >
          Save changes
        </Button>
        {dirty && (
          <p className="text-[10px] text-pink-shock uppercase font-mono">Unsaved changes</p>
        )}
      </div>
    </div>
  );
}

function CampaignPreview({ campaign }: { campaign: any }) {
  return (
    <div className="space-y-6">
      <div className="border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="font-mono text-[10px] uppercase text-foreground/50">Inbox preview</p>
            <h3 className="font-display text-xl italic uppercase">{campaign.subject}</h3>
            <p className="font-mono text-xs text-foreground/50 mt-1">
              {campaign.preview_text || "—"}
            </p>
          </div>
          <span className="font-mono text-xs text-foreground/40 uppercase">
            Via {campaign.name || "Brain Bolt"}
          </span>
        </div>
        <div
          className="bg-background p-6 border border-border min-h-[400px] font-sans text-sm leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: campaign.content_html || "<p>No HTML content yet.</p>",
          }}
        />
      </div>
      <div className="border border-border bg-card p-6">
        <p className="font-mono text-[10px] uppercase text-foreground/50">Plain-text version</p>
        <pre className="font-mono text-xs text-foreground/60 whitespace-pre-wrap break-words">
          {campaign.content_text || "No plain-text content yet."}
        </pre>
      </div>
    </div>
  );
}

function AudienceCard({
  segment,
  count,
  loading,
  onRefresh,
}: {
  segment: string;
  count: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const segmentLabels: Record<string, string> = {
    all_subscribers: "All eligible subscribers",
    authenticated_players: "Authenticated players with profiles",
    hosts: "Hosts (host role)",
  };

  return (
    <div className="space-y-6">
      <div className="border border-border bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="font-mono text-[10px] uppercase text-foreground/50">Audience segment</p>
            <h3 className="font-display text-xl italic uppercase">
              {segmentLabels[segment] || segment}
            </h3>
          </div>
          <Button
            onClick={onRefresh}
            disabled={loading}
            className="text-xs px-3 py-2 border border-border hover:border-volt hover:text-volt"
          >
            {loading ? <Loader2 className="size-4" /> : <RotateCcw className="size-4" />}
            Refresh
          </Button>
        </div>
        <p className="font-mono text-xs text-foreground/60 mb-4">
          Only users who have explicitly opted in and are not suppressed are eligible. Anonymous
          players are never included.
        </p>
        <div className="p-4 bg-background/30 border border-border rounded-md text-center">
          {loading ? (
            <Loader2 className="mx-auto h-8 w-8 animate-spin" />
          ) : (
            <div>
              <p className="font-display text-4xl italic text-volt">{count ?? "—"}</p>
              <p className="font-mono text-xs uppercase text-foreground/50 mt-1">
                eligible recipient{count === 1 ? "" : "s"}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="border border-border bg-card p-6">
        <p className="font-mono text-[10px] uppercase text-foreground/50 mb-4">
          How eligibility works
        </p>
        <ul className="space-y-3 text-sm font-mono text-foreground/60">
          <li className="flex items-start gap-2">
            <span className="text-volt">✓</span>
            User has opted in to announcements (email_subscriptions)
          </li>
          <li className="flex items-start gap-2">
            <span className="text-pink-shock">✗</span>
            User is not unsubscribed, hard-bounced, or complained
          </li>
          <li className="flex items-start gap-2">
            <span className="text-volt">✓</span>
            User has a known email address in auth.users
          </li>
          {segment === "authenticated_players" && (
            <li className="flex items-start gap-2">
              <span className="text-volt">✓</span>
              User has a public profile (authenticated player)
            </li>
          )}
          {segment === "hosts" && (
            <li className="flex items-start gap-2">
              <span className="text-volt">✓</span>
              User has the host role in user_roles
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function SendCard({
  campaign,
  canSend,
  audienceCount,
  onConfirmSend,
  onTestSend,
  testEmail,
  setTestEmail,
  testSending,
}: {
  campaign: any;
  canSend: boolean;
  audienceCount: number | null;
  onConfirmSend: () => void;
  onTestSend: () => void;
  testEmail: string;
  setTestEmail: (v: string) => void;
  testSending: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Test send */}
      <Card className="border border-border bg-card">
        <CardHeader className="p-4">
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-foreground/50">
            Test send
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 p-4">
          <div className="space-y-4">
            <p className="text-sm text-foreground/60 mb-2">
              Send a one-off test email to validate content before launching the campaign. Test
              sends are logged and do not affect campaign delivery status.
            </p>
            <div className="flex gap-2">
              <Input
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder="admin@example.com"
                className="flex-1"
              />
              <Button
                onClick={onTestSend}
                disabled={testSending || !testEmail}
                className="bg-volt text-background font-display text-base px-5 py-3 skew-cta disabled:opacity-50"
              >
                {testSending ? (
                  <Loader2 className="size-4 mr-2" />
                ) : (
                  <MailOpen className="size-4" />
                )}
                Send test
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Campaign send */}
      <Card className="border border-border bg-card">
        <CardHeader className="p-4">
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-foreground/50">
            Confirm & send
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 p-4">
          <div className="space-y-4">
            <div className="p-3 bg-background/30 border border-border rounded-md">
              <div className="flex justify-between mb-1">
                <span className="font-mono text-[10px] uppercase text-foreground/50">
                  Eligible recipients
                </span>
                <span className="font-display text-xl italic text-volt">
                  {audienceCount ?? "—"}
                </span>
              </div>
              <p className="font-mono text-[10px] uppercase text-foreground/50">
                Audience re-verified at send time. Unsubscribed and suppressed addresses are
                excluded.
              </p>
            </div>
            <div className="bg-amber-spark/10 border border-amber-spark/30 p-3 rounded-md">
              <p className="font-mono text-[10px] uppercase text-amber-spark mb-2">
                Final confirmation
              </p>
              <p className="text-sm text-foreground/70 mb-3">
                Once confirmed, the campaign will be sent to all eligible recipients. This cannot be
                undone. Failed recipients can be retried later.
              </p>
              <Button
                onClick={onConfirmSend}
                disabled={!canSend || audienceCount === 0 || audienceCount === null}
                className="bg-volt text-background font-display text-base px-6 py-4 skew-cta w-full disabled:opacity-50"
              >
                Confirm and send to {audienceCount ?? 0} recipient{audienceCount === 1 ? "" : "s"}
              </Button>
              {!canSend && audienceCount !== null && audienceCount === 0 && (
                <p className="text-[10px] text-foreground/50 uppercase font-mono mt-2">
                  No eligible recipients. Audience is empty until users opt in.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
