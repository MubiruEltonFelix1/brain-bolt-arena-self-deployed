import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthUser } from "./use-auth-user";

export type HostAuthorization = {
  id: string;
  authorization_type: "single" | "bundle" | "time";
  remaining_sessions: number | null;
  expires_at: string | null;
  status: "active" | "expired" | "revoked" | "consumed";
  starts_at: string;
  created_at: string;
};

export function useHostStatus() {
  const { user, loading: userLoading } = useAuthUser();
  const [authorization, setAuthorization] = useState<HostAuthorization | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasHostRole, setHasHostRole] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setAuthorization(null);
      setIsAdmin(false);
      setHasHostRole(false);
      setLoading(false);
      return;
    }
    // Roles come from the central role table — never from an email comparison.
    const [{ data: roles }, { data }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", user.id),
      supabase
        .from("host_authorizations")
        .select("id,authorization_type,remaining_sessions,expires_at,status,starts_at,created_at")
        .eq("profile_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const list = ((roles as { role: string }[] | null) ?? []).map((r) => r.role);
    setIsAdmin(list.includes("admin"));
    setHasHostRole(list.includes("host"));
    setAuthorization((data as HostAuthorization | null) ?? null);
    setLoading(false);
  }, [user]);

  useEffect(() => { if (!userLoading) refresh(); }, [userLoading, refresh]);


  const isActive = (() => {
    if (!authorization) return false;
    if (authorization.status !== "active") return false;
    if (authorization.authorization_type === "time") {
      return !authorization.expires_at || new Date(authorization.expires_at) > new Date();
    }
    return (authorization.remaining_sessions ?? 0) > 0;
  })();

  return {
    user,
    isAdmin,
    hasHostRole,
    authorization,
    canHost: isAdmin || hasHostRole || isActive,
    loading: userLoading || loading,
    refresh,
  };
}

