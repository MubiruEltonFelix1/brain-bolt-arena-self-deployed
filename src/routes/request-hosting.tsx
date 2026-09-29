import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthGate } from "@/hooks/use-auth-gate";
import { useHostStatus } from "@/hooks/use-host-status";
import { toast } from "sonner";
import { toastError } from "@/lib/errors";

type Purpose = "university" | "company" | "association" | "community" | "other";
type Size = "1-25" | "26-50" | "51-100";
type ExistingRequest = { id: string; status: "pending" | "approved" | "rejected"; organization: string; created_at: string };
type Draft = { organization: string; purpose: Purpose; expected: Size; message: string };

const EMPTY_DRAFT: Draft = { organization: "", purpose: "university", expected: "1-25", message: "" };
const DRAFT_KEY = "brainbolt:host-request-draft";

/** Non-sensitive form draft, scoped to the tab so it dies with the flow. */
function readDraft(): Draft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<Draft>) };
    return {
      organization: String(parsed.organization ?? ""),
      purpose: (PURPOSE_OPTIONS.some((o) => o.value === parsed.purpose) ? parsed.purpose : "university") as Purpose,
      expected: (["1-25", "26-50", "51-100"] as const).includes(parsed.expected as Size) ? (parsed.expected as Size) : "1-25",
      message: String(parsed.message ?? ""),
    };
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* a full or blocked storage must not break the form */
  }
}

function clearDraft() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing useful to do */
  }
}

export const Route = createFileRoute("/request-hosting")({
  component: RequestHosting,
});

const PURPOSE_OPTIONS: { value: Purpose; label: string }[] = [
  { value: "university", label: "University / School" },
  { value: "company", label: "Company Training" },
  { value: "association", label: "Association" },
  { value: "community", label: "Community Event" },
  { value: "other", label: "Other" },
];

function RequestHosting() {
  const navigate = useNavigate();
  const gate = useAuthGate({ reason: "host" });
  const { user } = gate;
  const { canHost, loading: hostLoading, refresh } = useHostStatus();

  // The draft survives the round-trip through the sign-in page so returning
  // users do not have to retype an application they already wrote. It is
  // non-sensitive, session-scoped, and dropped as soon as it is submitted.
  const [draft] = useState<Draft>(() => readDraft() ?? EMPTY_DRAFT);
  const [organization, setOrganization] = useState(draft.organization);
  const [purpose, setPurpose] = useState<Purpose>(draft.purpose);
  const [expected, setExpected] = useState<Size>(draft.expected);
  const [message, setMessage] = useState(draft.message);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<ExistingRequest | null>(null);
  const [loadingReq, setLoadingReq] = useState(true);

  useEffect(() => {
    writeDraft({ organization, purpose, expected, message });
  }, [organization, purpose, expected, message]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("host_requests" as never)
        .select("id,status,organization,created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      setExisting((data as ExistingRequest | null) ?? null);
      setLoadingReq(false);
    })();
  }, [user]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!organization.trim()) return toast.error("Organization is required");
    setBusy(true);
    const { error } = await supabase.rpc("submit_host_request" as never, {
      p_organization: organization,
      p_purpose: purpose,
      p_expected: expected,
      p_message: message,
    } as never);
    setBusy(false);
    if (error) return toastError(error, { context: "submit host request" });
    // Submitted: drop the draft so a later visit cannot replay it.
    clearDraft();
    toast.success("Request submitted");
    await refresh();
    navigate({ to: "/dashboard" });
  }

  if (gate.error) {
    return (
      <div className="min-h-screen grid place-items-center px-6">
        <div className="max-w-md space-y-4 text-center">
          <p className="font-display text-2xl italic uppercase">Can&apos;t confirm your session</p>
          <p className="text-sm text-foreground/60">{gate.error}</p>
          <button
            onClick={() => void gate.retry()}
            className="min-h-11 bg-volt text-background font-display text-lg uppercase italic px-6 py-3 skew-cta"
          >
            TRY AGAIN
          </button>
        </div>
      </div>
    );
  }

  if (gate.pending || hostLoading || loadingReq) {
    return <div className="min-h-screen grid place-items-center font-mono text-foreground/40 text-sm">LOADING...</div>;
  }
  // The gate redirects on this branch; rendering null avoids flashing the form
  // for a user who is genuinely on their way to the sign-in page.
  if (!user) return null;

  const statusBanner = canHost
    ? { className: "border-volt/50", tagClass: "text-volt", tag: "active", title: "Your hosting access is active", body: "You already have hosting access. Head to your dashboard to start a match." }
    : existing?.status === "pending"
    ? { className: "border-cyan-jolt/50", tagClass: "text-cyan-jolt", tag: "pending", title: "Your hosting request is under review", body: "An administrator will approve or reject your request shortly." }
    : existing?.status === "rejected"
    ? { className: "border-pink-shock/50", tagClass: "text-pink-shock", tag: "rejected", title: "Previous request was rejected", body: "You may submit a new request with updated details." }
    : null;

  const canSubmit = !canHost && existing?.status !== "pending";

  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="max-w-xl mx-auto space-y-8">
        <div>
          <Link to="/" className="font-mono text-xs uppercase text-foreground/50 hover:text-volt">← Back</Link>
          <p className="font-mono text-xs uppercase tracking-widest text-volt mt-4">Access request</p>
          <h1 className="font-display text-4xl italic uppercase mt-1">Request hosting access</h1>
          <p className="text-foreground/60 text-sm mt-2">
            Hosting is manually reviewed. Playing is always free — no account required.
          </p>
        </div>

        {statusBanner && (
          <div className={`border bg-card p-4 space-y-1 ${statusBanner.className}`}>
            <p className={`font-mono text-[10px] uppercase ${statusBanner.tagClass}`}>{statusBanner.tag}</p>
            <p className="font-display text-lg italic uppercase">{statusBanner.title}</p>
            <p className="text-foreground/70 text-sm">{statusBanner.body}</p>
            {canHost && (
              <Link to="/dashboard" className="inline-block mt-2 bg-volt text-background font-display text-sm px-4 py-2 skew-cta">
                GO TO DASHBOARD
              </Link>
            )}
          </div>
        )}

        {canSubmit && (
          <form onSubmit={submit} className="space-y-4">
            <div className="border border-border bg-card p-3">
              <p className="font-mono text-[10px] uppercase text-foreground/50">Requesting as</p>
              <p className="font-mono text-sm mt-1">{user.email}</p>
            </div>

            <label className="block">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Organization / group name</span>
              <input
                required maxLength={120} value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                className="w-full mt-1 bg-card border border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt"
              />
            </label>

            <label className="block">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Hosting purpose</span>
              <select
                value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}
                className="w-full mt-1 bg-card border border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt"
              >
                {PURPOSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="font-mono text-[10px] uppercase text-foreground/60">
                How many players do you expect?
              </span>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {(["1-25", "26-50", "51-100"] as Size[]).map((s) => (
                  <button
                    type="button" key={s}
                    onClick={() => setExpected(s)}
                    className={`px-3 py-3 font-mono text-xs uppercase border transition-colors ${
                      expected === s ? "border-volt text-volt bg-volt/5" : "border-border text-foreground/70 hover:border-volt/50"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </label>

            <label className="block">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Message / description</span>
              <textarea
                maxLength={1000} rows={4} value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us how you'll use BrainBolt"
                className="w-full mt-1 bg-card border border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt resize-none"
              />
            </label>

            <button
              type="submit" disabled={busy}
              className="w-full bg-volt text-background font-display text-xl py-4 skew-cta active:scale-95 disabled:opacity-60"
            >
              {busy ? "..." : "SUBMIT REQUEST"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
