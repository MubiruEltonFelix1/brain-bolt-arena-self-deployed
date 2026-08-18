import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HostShell } from "@/components/host-shell";
import { useHostStatus } from "@/hooks/use-host-status";
import { BrandBanner } from "@/components/BrandBanner";
import type { BrandingProfile } from "@/lib/branding";
import { toast } from "sonner";
import { toastError, toastHostAccessError } from "@/lib/errors";

export const Route = createFileRoute("/branding")({
  component: BrandingPage,
});

type Draft = {
  id: string | null;
  organization_name: string;
  logo_url: string;
  primary_color: string;
  secondary_color: string;
};

const EMPTY: Draft = {
  id: null,
  organization_name: "",
  logo_url: "",
  primary_color: "#CCFF00",
  secondary_color: "#FF2D55",
};

function BrandingPage() {
  const { user, canHost } = useHostStatus();
  const [profiles, setProfiles] = useState<BrandingProfile[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!user) return;
    const { data } = await supabase
      .from("branding_profiles")
      .select("*")
      .eq("owner_principal_id", user.id)
      .order("created_at", { ascending: false });
    setProfiles((data as BrandingProfile[] | null) ?? []);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line
  }, [user?.id]);

  function edit(p: BrandingProfile) {
    setDraft({
      id: p.id,
      organization_name: p.organization_name,
      logo_url: p.logo_url ?? "",
      primary_color: p.primary_color ?? "#CCFF00",
      secondary_color: p.secondary_color ?? "#FF2D55",
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!canHost) return toastHostAccessError({ context: "save branding pre-check" });
    const name = draft.organization_name.trim();
    if (name.length < 2) return toast.error("Organization name required");

    setSaving(true);
    const payload = {
      owner_principal_id: user.id,
      organization_name: name,
      logo_url: draft.logo_url.trim() || null,
      primary_color: draft.primary_color || null,
      secondary_color: draft.secondary_color || null,
    };

    const { error } = draft.id
      ? await supabase.from("branding_profiles").update(payload).eq("id", draft.id)
      : await supabase.from("branding_profiles").insert(payload as never);
    setSaving(false);
    if (error) return toastError(error, { context: "save branding" });
    toast.success(draft.id ? "Branding updated" : "Branding created");
    setDraft(EMPTY);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this branding profile? Existing sessions using it will fall back to BrainBolt defaults.")) return;
    const { error } = await supabase.from("branding_profiles").delete().eq("id", id);
    if (error) return toastError(error, { context: "delete branding" });
    toast.success("Deleted");
    if (draft.id === id) setDraft(EMPTY);
    load();
  }

  const preview: BrandingProfile = {
    id: draft.id ?? "preview",
    owner_principal_id: user?.id ?? "",
    organization_name: draft.organization_name || "Your Organization",
    logo_url: draft.logo_url || null,
    primary_color: draft.primary_color || null,
    secondary_color: draft.secondary_color || null,
  };

  return (
    <HostShell title="Branding">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-volt">Competition branding</p>
          <h1 className="font-display text-5xl italic uppercase mt-1">Organization branding</h1>
          <p className="text-foreground/60 text-sm mt-2 max-w-xl">
            Add your organization's identity to matches. BrainBolt branding stays visible — this
            adds a "Presented by" banner across the lobby, host, player and results screens.
          </p>
        </div>

        <section className="grid md:grid-cols-2 gap-6">
          <form onSubmit={save} className="bg-card border border-border p-6 space-y-4">
            <h2 className="font-display text-2xl italic uppercase">
              {draft.id ? "Edit profile" : "New profile"}
            </h2>

            <label className="block space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Organization name</span>
              <input
                value={draft.organization_name}
                onChange={(e) => setDraft({ ...draft, organization_name: e.target.value })}
                placeholder="Makerere Tech Challenge"
                className="w-full bg-background border border-border px-3 py-2 focus:outline-none focus:border-volt"
                maxLength={80}
              />
            </label>

            <label className="block space-y-1">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Logo URL (optional)</span>
              <input
                value={draft.logo_url}
                onChange={(e) => setDraft({ ...draft, logo_url: e.target.value })}
                placeholder="https://your-org.com/logo.png"
                className="w-full bg-background border border-border px-3 py-2 focus:outline-none focus:border-volt"
              />
              <span className="text-[10px] text-foreground/40">Paste a public image URL. Square, min 128×128 recommended.</span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Primary</span>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={draft.primary_color}
                    onChange={(e) => setDraft({ ...draft, primary_color: e.target.value })}
                    className="h-10 w-14 bg-background border border-border"
                  />
                  <input
                    value={draft.primary_color}
                    onChange={(e) => setDraft({ ...draft, primary_color: e.target.value })}
                    className="flex-1 bg-background border border-border px-2 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt"
                  />
                </div>
              </label>
              <label className="block space-y-1">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Secondary</span>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={draft.secondary_color}
                    onChange={(e) => setDraft({ ...draft, secondary_color: e.target.value })}
                    className="h-10 w-14 bg-background border border-border"
                  />
                  <input
                    value={draft.secondary_color}
                    onChange={(e) => setDraft({ ...draft, secondary_color: e.target.value })}
                    className="flex-1 bg-background border border-border px-2 py-2 font-mono text-xs uppercase focus:outline-none focus:border-volt"
                  />
                </div>
              </label>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                disabled={saving || !canHost}
                className="bg-volt text-background font-display text-base px-5 py-2.5 skew-cta disabled:opacity-40"
              >
                {saving ? "..." : draft.id ? "SAVE" : "CREATE"}
              </button>
              {draft.id && (
                <button
                  type="button"
                  onClick={() => setDraft(EMPTY)}
                  className="font-mono text-xs uppercase text-foreground/60 hover:text-volt"
                >
                  Cancel
                </button>
              )}
            </div>
            {!canHost && (
              <p className="text-[11px] text-foreground/50">
                You need hosting authorization to create branding profiles.
              </p>
            )}
          </form>

          <div className="space-y-3">
            <h2 className="font-display text-2xl italic uppercase">Preview</h2>
            <BrandBanner branding={preview} />
            <BrandBanner branding={preview} variant="compact" className="border border-border p-3 bg-card" />
            <div className="border border-border p-4 bg-card space-y-2">
              <div className="flex gap-2">
                <span
                  className="inline-block h-6 w-6 border border-border"
                  style={{ background: preview.primary_color ?? "transparent" }}
                />
                <span
                  className="inline-block h-6 w-6 border border-border"
                  style={{ background: preview.secondary_color ?? "transparent" }}
                />
              </div>
              <p className="text-[11px] text-foreground/50 font-mono uppercase">Color tokens</p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-2xl italic uppercase">Your profiles</h2>
          {profiles.length === 0 ? (
            <div className="border-2 border-dashed border-border p-8 text-center text-foreground/50 text-sm">
              No branding profiles yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {profiles.map((p) => (
                <li key={p.id} className="bg-card border border-border p-4 flex items-center gap-4">
                  {p.logo_url ? (
                    <img src={p.logo_url} alt="" className="h-10 w-10 object-contain bg-white/5 p-1" />
                  ) : (
                    <div className="h-10 w-10 bg-background border border-border grid place-items-center text-xs font-mono text-foreground/40">—</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-display italic uppercase truncate">{p.organization_name}</p>
                    <div className="flex gap-1 mt-1">
                      {p.primary_color && <span className="h-3 w-3 border border-border" style={{ background: p.primary_color }} />}
                      {p.secondary_color && <span className="h-3 w-3 border border-border" style={{ background: p.secondary_color }} />}
                    </div>
                  </div>
                  <button
                    onClick={() => edit(p)}
                    className="font-mono text-xs uppercase border border-border px-3 py-1.5 hover:border-volt hover:text-volt"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(p.id)}
                    className="font-mono text-xs uppercase border border-border px-3 py-1.5 hover:border-pink-shock hover:text-pink-shock"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </HostShell>
  );
}
