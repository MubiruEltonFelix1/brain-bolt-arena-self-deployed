import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toastError, logActionError } from "@/lib/errors";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

type AdminUser = {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  auth_id: string | null;
  authorization_type: "single" | "bundle" | "time" | null;
  remaining_sessions: number | null;
  expires_at: string | null;
  status: "active" | "expired" | "revoked" | "consumed" | null;
  is_active: boolean | null;
};

type HostRequest = {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  organization: string;
  purpose: string;
  expected_participants: string;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
};

export function UsersSection() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: list, error: e1 } = await supabase.rpc("admin_list_users", {
        p_search: search || undefined,
      } as never);
      if (e1) {
        toastError(e1, { context: "admin users load" });
        setError("Failed to load users. Try again.");
        setUsers([]);
        setLoading(false);
        return;
      }
      setUsers((list as AdminUser[] | null) ?? []);
    } catch (err) {
      logActionError(err, "admin users load");
      setError("Failed to load users. Try again.");
      setLoading(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [search]);

  async function grant(
    profileId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) {
    setBusy(true);
    const { error } = await supabase.rpc("admin_grant_host_authorization", {
      p_profile_id: profileId,
      p_type: type,
      p_sessions: sessions ?? undefined,
      p_expires_at: expiresAt ?? undefined,
      p_notes: undefined,
    } as never);
    setBusy(false);
    if (error) return toastError(error, { context: "admin grant host authorization" });
    toast.success("Authorization granted");
    load();
  }

  async function revoke(authId: string) {
    if (!confirm("Revoke this hosting authorization?")) return;
    const { error } = await supabase.rpc("admin_revoke_host_authorization", {
      p_auth_id: authId,
    } as never);
    if (error) return toastError(error, { context: "admin revoke host authorization" });
    toast.success("Revoked");
    load();
  }

  async function extend(
    authId: string,
    addSessions: number | undefined,
    newExpires: string | undefined,
  ) {
    const { error } = await supabase.rpc("admin_extend_host_authorization", {
      p_auth_id: authId,
      p_add_sessions: addSessions ?? undefined,
      p_new_expires_at: newExpires ?? undefined,
    } as never);
    if (error) return toastError(error, { context: "admin extend host authorization" });
    toast.success("Updated");
    load();
  }

  async function convert(
    authId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) {
    const { error } = await supabase.rpc("admin_convert_host_authorization", {
      p_auth_id: authId,
      p_type: type,
      p_sessions: sessions ?? undefined,
      p_expires_at: expiresAt ?? undefined,
    } as never);
    if (error) return toastError(error, { context: "admin convert host authorization" });
    toast.success("Converted");
    load();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="border border-pink-shock/50 bg-pink-shock/10 p-4 font-mono text-xs uppercase text-pink-shock">
          {error}
          <button onClick={load} className="ml-3 underline underline-offset-4 hover:text-volt">
            Try again
          </button>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/50">
            Users
          </p>
          <h2 className="font-display text-3xl italic uppercase">User management</h2>
        </div>
        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
            placeholder="Search by name or email"
            className="flex-1 bg-background border border-border px-4 py-3 font-mono text-sm focus:outline-none focus:border-volt"
          />
          <button
            onClick={load}
            disabled={loading}
            className="bg-volt text-background font-display text-base px-5 py-3 skew-cta disabled:opacity-50"
          >
            SEARCH
          </button>
        </div>
      </div>

      <HostRequestsPanel onChange={load} loading={loading} />

      <div className="border border-border">
        {loading ? (
          <div className="space-y-3 p-8">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-foreground/50 font-mono text-sm uppercase">
            No users
          </div>
        ) : (
          users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              busy={busy}
              onGrant={grant}
              onRevoke={revoke}
              onExtend={extend}
              onConvert={convert}
            />
          ))
        )}
      </div>
    </div>
  );
}

function HostRequestsPanel({ onChange, loading }: { onChange: () => void; loading: boolean }) {
  const [items, setItems] = useState<HostRequest[]>([]);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.rpc(
      "admin_list_host_requests" as never,
      {
        p_status: filter === "all" ? null : filter,
      } as never,
    );
    if (error) return toastError(error, { context: "admin list host requests" });
    setItems((data as HostRequest[] | null) ?? []);
  }

  useEffect(() => {
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [filter]);

  async function approve(id: string) {
    setBusyId(id);
    const { error } = await supabase.rpc(
      "admin_approve_host_request" as never,
      { p_request_id: id } as never,
    );
    setBusyId(null);
    if (error) return toastError(error, { context: "admin approve host request" });
    toast.success("Approved · 90-day access granted");
    load();
    onChange();
  }

  async function reject(id: string) {
    if (!confirm("Reject this hosting request?")) return;
    setBusyId(id);
    const { error } = await supabase.rpc(
      "admin_reject_host_request" as never,
      { p_request_id: id } as never,
    );
    setBusyId(null);
    if (error) return toastError(error, { context: "admin reject host request" });
    toast.success("Rejected");
    load();
  }

  const pendingCount = items.filter((i) => i.status === "pending").length;

  return (
    <div className="border border-border bg-card">
      <div className="flex items-center justify-between p-4 border-b border-border gap-2 flex-wrap">
        <div>
          <p className="font-mono text-[10px] uppercase text-cyan-jolt">Host requests</p>
          <p className="font-display text-xl italic uppercase">
            {filter === "pending"
              ? `${pendingCount} pending`
              : `${items.length} ${filter === "all" ? "requests" : filter}`}
          </p>
        </div>
        <div className="flex gap-1">
          {(["pending", "approved", "rejected", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 font-mono text-[10px] uppercase border ${filter === f ? "border-volt text-volt" : "border-border text-foreground/60 hover:text-volt"}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center font-mono text-xs uppercase text-foreground/40">
          No {filter === "all" ? "" : filter} requests
        </div>
      ) : (
        <div>
          {items.map((r) => (
            <div key={r.id} className="border-b border-border last:border-b-0 p-4 space-y-2">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <p className="font-display text-base italic uppercase truncate">
                    {r.organization}
                  </p>
                  <p className="font-mono text-[11px] text-foreground/60 truncate">
                    {r.display_name || r.email} · {r.email}
                  </p>
                  <p className="font-mono text-[10px] uppercase text-foreground/50 mt-1">
                    {r.purpose} · {r.expected_participants} ·{" "}
                    {new Date(r.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span
                  className={`font-mono text-[10px] uppercase px-2 py-1 border ${r.status === "pending" ? "border-cyan-jolt text-cyan-jolt" : r.status === "approved" ? "border-volt text-volt" : "border-pink-shock text-pink-shock"}`}
                >
                  {r.status}
                </span>
              </div>
              {r.message && (
                <p className="font-mono text-xs text-foreground/60 italic">{r.message}</p>
              )}
              <div className="flex gap-2 pt-2 border-t border-border">
                {r.status === "pending" && (
                  <>
                    <button
                      onClick={() => approve(r.id)}
                      disabled={busyId === r.id || loading}
                      className="bg-volt text-background font-display text-xs px-4 py-2 skew-cta disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => reject(r.id)}
                      disabled={busyId === r.id || loading}
                      className="border border-pink-shock text-pink-shock px-4 py-2 font-mono text-xs uppercase hover:bg-pink-shock hover:text-background disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UserRow({
  user,
  busy,
  onGrant,
  onRevoke,
  onExtend,
  onConvert,
}: {
  user: AdminUser;
  busy: boolean;
  onGrant: (
    profileId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) => void;
  onRevoke: (authId: string) => void;
  onExtend: (
    authId: string,
    addSessions: number | undefined,
    newExpires: string | undefined,
  ) => void;
  onConvert: (
    authId: string,
    type: "single" | "bundle" | "time",
    sessions: number | undefined,
    expiresAt: string | undefined,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"single" | "bundle" | "time">("single");
  const [sessions, setSessions] = useState(5);
  const [expires, setExpires] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  });

  const status = user.is_active
    ? user.authorization_type === "time"
      ? `Time-based · expires ${user.expires_at ? new Date(user.expires_at).toLocaleDateString() : "—"}`
      : `${user.authorization_type === "single" ? "Single game" : "Game bundle"} · ${user.remaining_sessions ?? 0} left to host`
    : user.status
      ? `Inactive (${user.status})`
      : "No authorization";

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between p-4 gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="font-display text-lg italic uppercase truncate">
            {user.display_name || user.email}
          </p>
          <p className="font-mono text-xs text-foreground/50 truncate">{user.email}</p>
        </div>
        <div className="text-right">
          <p
            className={`font-mono text-xs uppercase ${user.is_active ? "text-volt" : "text-foreground/50"}`}
          >
            {status}
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
        >
          {open ? "Close" : "Edit access"}
        </button>
      </div>

      {open && (
        <div className="bg-background/50 border-t border-border p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
            <label className="block">
              <span className="font-mono text-[10px] uppercase text-foreground/60">Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs uppercase"
              >
                <option value="single">Single game</option>
                <option value="bundle">Game bundle</option>
                <option value="time">Time-based</option>
              </select>
            </label>
            {type === "bundle" && (
              <label className="block">
                <span className="font-mono text-[10px] uppercase text-foreground/60">
                  Games in the bundle
                </span>
                <input
                  type="number"
                  min={1}
                  value={sessions}
                  onChange={(e) => setSessions(parseInt(e.target.value) || 1)}
                  className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs"
                />
              </label>
            )}
            {type === "time" && (
              <label className="block">
                <span className="font-mono text-[10px] uppercase text-foreground/60">Expires</span>
                <input
                  type="date"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  className="w-full mt-1 bg-background border border-border px-3 py-2 font-mono text-xs"
                />
              </label>
            )}
            <button
              disabled={busy}
              onClick={() =>
                onGrant(
                  user.id,
                  type,
                  type === "bundle" ? sessions : type === "single" ? 1 : undefined,
                  type === "time" ? new Date(expires).toISOString() : undefined,
                )
              }
              className="bg-volt text-background font-display text-base px-4 py-2.5 skew-cta disabled:opacity-50"
            >
              GRANT / REPLACE
            </button>
          </div>

          {user.auth_id && user.is_active && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
              {(user.authorization_type === "single" || user.authorization_type === "bundle") && (
                <button
                  onClick={() => {
                    const n = parseInt(
                      prompt("How many extra games should this host be able to run?", "5") || "0",
                    );
                    if (n > 0) onExtend(user.auth_id!, n, undefined);
                  }}
                  className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
                >
                  + Sessions
                </button>
              )}
              {user.authorization_type === "time" && (
                <button
                  onClick={() => {
                    const d = prompt("New expiry date (YYYY-MM-DD)?");
                    if (d) onExtend(user.auth_id!, undefined, new Date(d).toISOString());
                  }}
                  className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
                >
                  Extend expiry
                </button>
              )}
              <button
                onClick={() =>
                  onConvert(
                    user.auth_id!,
                    type,
                    type === "bundle" ? sessions : type === "single" ? 1 : undefined,
                    type === "time" ? new Date(expires).toISOString() : undefined,
                  )
                }
                className="border border-border px-3 py-2 font-mono text-xs uppercase hover:border-volt hover:text-volt"
              >
                Convert to selected
              </button>
              <button
                onClick={() => onRevoke(user.auth_id!)}
                className="border border-pink-shock text-pink-shock px-3 py-2 font-mono text-xs uppercase hover:bg-pink-shock hover:text-background"
              >
                Revoke
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
