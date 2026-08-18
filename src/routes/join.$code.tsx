import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { TEAM_COLORS } from "@/lib/game";
import { getParticipant, saveParticipant } from "@/lib/participant-storage";
import { BrandBanner } from "@/components/BrandBanner";
import { AvatarPicker } from "@/components/AvatarPicker";
import { DEFAULT_AVATAR_ID } from "@/lib/avatar";
import type { BrandingProfile } from "@/lib/branding";
import { toast } from "sonner";
import { toastError, logActionError } from "@/lib/errors";
import { LiveScreenState } from "@/components/ConnectionState";
import { describeGameCode, lookupGameCode, type GameCodeLookup } from "@/lib/game-code";


export const Route = createFileRoute("/join/$code")({
  component: JoinPage,
  errorComponent: () => (
    <LiveScreenState
      spinner={false}
      title="Something interrupted the join"
      message="We couldn't finish loading this match. Check your connection and try again."
      action={{ label: "TRY AGAIN", onClick: () => window.location.reload() }}
    />
  ),
});


type SessionLite = {
  id: string;
  code: string;
  status: string;
  team_mode: boolean;
  quiz: { title: string } | null;
  branding: BrandingProfile | null;
};

type Team = { id: string; name: string; color: string };

function JoinPage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionLite | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [nickname, setNickname] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [avatarId, setAvatarId] = useState<string>(DEFAULT_AVATAR_ID);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<"network" | "missing" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [codeInfo, setCodeInfo] = useState<GameCodeLookup | null>(null);

  // Explain what this code is (live lobby vs scheduled competition) so the
  // player never has to reason about the underlying lifecycle.
  useEffect(() => {
    let cancelled = false;
    lookupGameCode(code)
      .then((info) => { if (!cancelled) setCodeInfo(info); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [code]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("sessions")
        .select("id, code, status, team_mode, quiz:quizzes(title), branding:branding_profiles(id,owner_principal_id,organization_name,logo_url,primary_color,secondary_color)")
        .eq("code", code)
        .maybeSingle();
      if (cancelled) return;
      // A network hiccup is recoverable; a genuinely missing code is not.
      if (error) { setLoadError("network"); return; }
      if (!data) { setLoadError("missing"); return; }
      setLoadError(null);
      setSession(data as unknown as SessionLite);

      // existing participant?
      const existing = getParticipant(data.id);
      if (existing) {
        navigate({ to: "/play/$sessionId", params: { sessionId: data.id } });
        return;
      }

      if (data.team_mode) {
        const { data: t } = await supabase.from("teams").select("id,name,color").eq("session_id", data.id);
        if (!cancelled) setTeams(t || []);
      }
    })();
    return () => { cancelled = true; };
  }, [code, navigate, attempt]);


  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    const nick = nickname.trim();
    if (nick.length < 2) {
      toast.error("Pick a nickname");
      return;
    }
    if (session.team_mode && !teamId) {
      toast.error("Pick a team");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("join_session", {
      p_code: code,
      p_nickname: nick,
      p_team_id: teamId ?? undefined,
      p_avatar_id: avatarId,
    });
    setBusy(false);
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      if (error?.message?.includes("not accepting")) {
        logActionError(error, "join game (session not accepting)");
        toast.error("Session not joinable");
      } else {
        toastError(error, { context: "join game", fallback: "Could not join this session." });
      }
      return;
    }
    saveParticipant({
      id: row.participant_id,
      sessionId: row.session_id,
      nickname: nick,
      secretToken: row.secret_token,
      avatarId,
    });
    navigate({ to: "/play/$sessionId", params: { sessionId: row.session_id } });
  }

  if (!session) {
    if (loadError === "missing") {
      return (
        <LiveScreenState
          spinner={false}
          title="Match not found"
          message={`No live match is using code ${code}. Double-check the code with your host.`}
          action={{ label: "BACK TO ARENA", onClick: () => navigate({ to: "/" }) }}
        />
      );
    }
    if (loadError === "network") {
      return (
        <LiveScreenState
          spinner={false}
          title="Can't reach the arena"
          message="Your connection dropped while loading this match. Nothing has been lost."
          action={{ label: "TRY AGAIN", onClick: () => { setLoadError(null); setAttempt((a) => a + 1); } }}
        />
      );
    }
    return <LiveScreenState title="Finding your match" message={`Looking up code ${code}...`} />;
  }


  return (
    <div className="min-h-screen bg-background px-6 py-12 flex flex-col">
      <Link to="/" className="font-mono text-xs uppercase text-foreground/60 hover:text-volt">← Cancel</Link>

      <div className="flex-1 max-w-sm w-full mx-auto flex flex-col justify-center space-y-8 animate-float">
        {session.branding && <BrandBanner branding={session.branding} />}
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-volt">CODE {session.code}</p>
          {codeInfo && (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-foreground/50">
              {describeGameCode(codeInfo).label} · {describeGameCode(codeInfo).detail}
            </p>
          )}
          <h1 className="font-display text-5xl italic uppercase mt-2 leading-none">
            {session.quiz?.title ?? "Quiz Match"}
          </h1>
        </div>


        <form onSubmit={handleJoin} className="space-y-4">
          <input
            placeholder="NICKNAME"
            maxLength={16}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            className="w-full bg-card border-2 border-border py-5 px-6 text-2xl font-display tracking-wider text-center focus:outline-none focus:border-volt uppercase"
            autoFocus
          />

          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Pick your champion</p>
            <AvatarPicker value={avatarId} onChange={setAvatarId} columns={5} />
          </div>

          {session.team_mode && (
            <div className="space-y-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">Pick squad</p>
              <div className="grid grid-cols-2 gap-2">
                {teams.length === 0 ? (
                  <p className="col-span-2 text-foreground/40 text-sm font-mono">Host still setting up teams...</p>
                ) : teams.map((t, i) => {
                  const color = t.color || TEAM_COLORS[i % TEAM_COLORS.length];
                  const selected = teamId === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTeamId(t.id)}
                      className={`p-4 border-2 text-left transition-all ${selected ? "border-volt bg-volt/5" : "border-border bg-card hover:border-foreground/40"}`}
                    >
                      <div className="size-3 mb-2" style={{ background: color }} />
                      <p className="font-bold text-sm">{t.name}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <button
            disabled={busy}
            className="w-full bg-volt text-background font-display text-2xl py-5 skew-cta active:scale-95 transition-transform disabled:opacity-50"
          >
            {busy ? "..." : "LOCK IN"}
          </button>
        </form>
      </div>
    </div>
  );
}
