/* eslint-disable @typescript-eslint/no-explicit-any */
// Campaign data comes from untyped server-function envelopes; `any` is used
// consistently with the existing admin codebase (arena-admin.functions.ts).

// src/components/admin/campaigns/CampaignListSection.tsx
//
// Campaign list and creation entry point for the Email & Communications
// section of Mission Control. Reads real campaign records from the server
// via email server functions. Never exposes recipient email addresses to
// the browser — only counts and summaries.

import { useEffect, useState, useCallback } from "react";
import { Plus, Mail, Clock, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";
import {
  emailListCampaigns,
  emailCreateCampaign,
  emailResolveAudience,
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

export function CampaignListSection({
  onCampaignSelect,
}: {
  onCampaignSelect: (campaignId: string) => void;
}) {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await emailListCampaigns({ data: {} });
    if (!result.ok) {
      setError(result.error === "unauthorized" ? "Not authorized" : "Failed to load campaigns");
      setLoading(false);
      return;
    }
    setCampaigns(result.campaigns ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    const result = await emailCreateCampaign({
      data: {
        name: "New Campaign",
        subject: "",
        previewText: "",
        contentHtml: "",
        contentText: "",
        audienceSegment: "all_subscribers",
      },
    });
    if (!result.ok) {
      toastError(
        result.error === "unauthorized"
          ? new Error("Not authorized")
          : new Error("Failed to create campaign"),
      );
      return;
    }
    onCampaignSelect(result.campaign?.id as string);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader onCreate={handleCreate} />
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
      <div className="space-y-6">
        <PageHeader onCreate={handleCreate} />
        <div className="border border-border bg-card p-6 text-center">
          <AlertCircle className="mx-auto h-10 w-10 text-pink-shock mb-3" />
          <h3 className="font-display text-xl italic uppercase mb-2">Unable to load campaigns</h3>
          <p className="text-foreground/60 text-sm mb-4">{error}</p>
          <Button onClick={load} variant="default">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader onCreate={handleCreate} />

      {campaigns.length === 0 ? (
        <EmptyState onCreate={handleCreate} />
      ) : (
        <CampaignList campaigns={campaigns} onCampaignSelect={onCampaignSelect} />
      )}
    </div>
  );
}

function PageHeader({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
          Email & Communications
        </p>
        <h2 className="font-display text-3xl italic uppercase">Campaigns</h2>
      </div>
      <Button
        onClick={onCreate}
        className="bg-volt text-background font-display text-base px-5 py-3 skew-cta flex items-center gap-2"
      >
        <Plus className="size-4" /> Create campaign
      </Button>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="border border-border bg-card p-12 text-center">
      <Mail className="mx-auto h-12 w-12 text-foreground/20 mb-4" />
      <h3 className="font-display text-2xl italic uppercase mb-2">No campaigns yet</h3>
      <p className="text-foreground/60 text-sm max-w-md mx-auto mb-6 leading-relaxed">
        Create your first announcement campaign to send email to eligible subscribers. The audience
        starts empty until users explicitly opt in.
      </p>
      <Button
        className="bg-volt text-background font-display text-base px-5 py-3 skew-cta"
        onClick={onCreate}
      >
        Create campaign
      </Button>
    </div>
  );
}

function CampaignList({
  campaigns,
  onCampaignSelect,
}: {
  campaigns: any[];
  onCampaignSelect: (campaignId: string) => void;
}) {
  return (
    <div className="border border-border bg-card overflow-hidden">
      <CardHeader className="p-4 border-b border-border">
        <CardTitle className="font-mono text-xs uppercase tracking-widest text-foreground/50">
          Campaign history
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/3">Campaign</TableHead>
              <TableHead className="w-1/6">Status</TableHead>
              <TableHead className="w-1/6">Audience</TableHead>
              <TableHead className="w-1/10 text-right">Recipients</TableHead>
              <TableHead className="w-1/10 text-right">Delivered</TableHead>
              <TableHead className="w-1/12">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => {
              const badge = statusBadge(c.status);
              return (
                <TableRow
                  key={c.id}
                  className="hover:bg-background/30 transition-colors cursor-pointer"
                  onClick={() => onCampaignSelect(c.id)}
                >
                  <TableCell className="font-mono text-sm italic uppercase truncate">
                    {c.name || c.subject}
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/60 uppercase">
                    {c.audience_segment?.replace(/_/g, " ") || "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {c.recipient_count?.toLocaleString() ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-foreground/60">
                    {c.delivered_count?.toLocaleString() ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-foreground/50">
                    {formatDate(c.created_at)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </div>
  );
}
