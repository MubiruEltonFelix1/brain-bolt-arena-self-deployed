import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { EmptyState } from "@/components/EmptyState";
import { useHostStatus } from "@/hooks/use-host-status";
import { toastError, toastHostAccessError } from "@/lib/errors";

export const Route = createFileRoute("/leagues/")({
  component: LeaguesPage,
});

type LeagueStatus = "draft" | "registration_open" | "active" | "completed";
type LeagueVisibility = "public" | "private";
type League = {
  id: string;
  name: string;
  description: string | null;
  season: string | null;
  status: LeagueStatus;
  visibility: LeagueVisibility;
  start_date: string | null;
  end_date: string | null;
  cover_image_url: string | null;
  archived_at: string | null;
};

const STATUS_LABEL: Record<LeagueStatus, string> = {
  draft: "Draft",
  registration_open: "Registration",
  active: "Active",
  completed: "Completed",
};

function LeaguesPage() {
  const navigate = useNavigate();
  const { user, canHost } = useHostStatus();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [visibility, setVisibility] = useState<LeagueVisibility>("private");
  const [coverUrl, setCoverUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    if (!user) return;
    const { data } = await supabase
      .from("leagues")
      .select("*")
      .eq("owner_principal_id", user.id)
      .order("created_at", { ascending: false });
    setLeagues((data as League[] | null) ?? []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user?.id]);

  async function createLeague(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !name.trim()) return;
    if (!canHost) return toastHostAccessError({ context: "create league pre-check", requestHostAccess: () => navigate({ to: "/request-hosting" }) });
    setBusy(true);
    const { error } = await supabase.from("leagues").insert({
      owner_principal_id: user.id,
      name: name.trim(),
      description: description.trim() || null,
      start_date: startDate || null,
      end_date: endDate || null,
      visibility,
      cover_image_url: coverUrl.trim() || null,
    } as never);
    setBusy(false);
    if (error) return toastError(error, { context: "create league" });
    setName(""); setDescription(""); setStartDate(""); setEndDate(""); setCoverUrl(""); setVisibility("private");
    setShowForm(false);
    load();
  }

  return (
    <HostShell title="Leagues">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="font-mono text-xs uppercase text-volt">Persistent competition</p>
            <h1 className="font-display text-5xl italic uppercase mt-1">Leagues</h1>
            <p className="text-foreground/60 text-sm mt-2 max-w-lg">
              Group multiple quizzes into a season. Players compete across every match.
            </p>
          </div>
          <button
            onClick={() => setShowForm((s) => !s)}
            disabled={!canHost}
            className="bg-volt text-background font-display text-base px-5 py-3 skew-cta disabled:opacity-40"
          >
            {showForm ? "CANCEL" : "+ NEW LEAGUE"}
          </button>
        </div>

        {showForm && (
          <form onSubmit={createLeague} className="bg-card border border-border p-5 grid gap-3 md:grid-cols-2">
            <input
              placeholder="LEAGUE NAME"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="md:col-span-2 bg-background border border-border px-4 py-3 font-mono text-sm uppercase focus:outline-none focus:border-volt"
              required
            />
            <textarea
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="md:col-span-2 bg-background border border-border px-4 py-3 font-mono text-xs focus:outline-none focus:border-volt"
            />
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Start date</span>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">End date</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Visibility</span>
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as LeagueVisibility)}
                className="bg-background border border-border px-3 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt">
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </label>
            <input
              placeholder="Cover image URL (optional)"
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              className="bg-background border border-border px-3 py-2 font-mono text-xs focus:outline-none focus:border-volt"
            />
            <button disabled={busy} className="md:col-span-2 bg-volt text-background font-display text-base py-3 skew-cta disabled:opacity-50">
              CREATE LEAGUE
            </button>
          </form>
        )}

        <div className="space-y-3">
          {leagues.length === 0 && (
            <EmptyState
              eyebrow="Leagues"
              title="Run a season, not just a night"
              body="A league aggregates results from several competitions into one set of standings. Create a league, attach quizzes, then point scheduled competitions at it."
            />
          )}
          {leagues.map((l) => (
            <Link
              key={l.id}
              to="/leagues/$id"
              params={{ id: l.id }}
              className="bg-card border border-border p-5 flex items-center justify-between hover:border-volt transition-colors"
            >
              <div className="flex items-center gap-4">
                {l.cover_image_url && (
                  <img src={l.cover_image_url} alt="" className="size-14 object-cover border border-border" />
                )}
                <div>
                  <p className="font-display text-xl italic uppercase">{l.name}</p>
                  <p className="font-mono text-[10px] uppercase text-foreground/40 mt-1">
                    {l.archived_at ? "Archived" : STATUS_LABEL[l.status]} · {l.visibility}
                    {l.start_date && ` · ${l.start_date}`}
                    {l.end_date && ` → ${l.end_date}`}
                  </p>
                </div>
              </div>
              <span className="font-mono text-xs uppercase text-volt">View →</span>
            </Link>
          ))}
        </div>
      </div>
    </HostShell>
  );
}
