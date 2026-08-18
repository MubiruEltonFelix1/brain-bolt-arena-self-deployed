import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toastError } from "@/lib/errors";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  validateSearch: (s: Record<string, unknown>): { next?: string } =>
    typeof s.next === "string" ? { next: s.next } : {},
});

function AuthPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const dest = (next && next.startsWith("/")) ? next : "/dashboard";
  const goNext = () => navigate({ to: dest as never });
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) goNext();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName || email.split("@")[0] },
            emailRedirectTo: window.location.origin + dest,
          },
        });
        if (error) throw error;
        toast.success("Account created");
        goNext();
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        goNext();
      }
    } catch (err) {
      toastError(err, { context: "sign in", fallback: "Could not sign in. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setBusy(true);
    // Native Supabase OAuth (Lovable's cloud-auth proxy is not available off Lovable).
    // The Google provider must be configured in the Supabase project's Auth settings
    // with this app's domain in the allowed redirect URLs.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin + dest,
      },
    });
    if (error) {
      toastError(error, { context: "google sign in", fallback: "Could not start Google sign-in." });
      setBusy(false);
    }
    // On success the browser is redirected to Google and back — no post-call navigation.
  }

  return (
    <div className="min-h-screen bg-background grid place-items-center px-6 py-12">
      <div className="w-full max-w-sm space-y-8 animate-float">
        <Link to="/" className="flex items-center gap-2 justify-center">
          <div className="size-8 bg-volt grid place-items-center skew-x-[-12deg]">
            <span className="font-display text-background text-xl italic">B</span>
          </div>
          <span className="font-display text-2xl italic">BRAINBOLT</span>
        </Link>

        <div>
          <h1 className="font-display text-4xl uppercase italic tracking-tighter">
            {mode === "signin" ? "Host login" : "Host signup"}
          </h1>
          <p className="text-foreground/60 text-sm mt-1">
            Players join with a game code — no account needed.
          </p>
        </div>

        <button
          onClick={handleGoogle}
          disabled={busy}
          className="w-full bg-card border border-border py-3 font-mono text-xs uppercase tracking-widest hover:border-volt hover:text-volt transition-colors disabled:opacity-50"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-3 text-foreground/40 text-[10px] font-mono uppercase">
          <span className="flex-1 h-px bg-border" />
          OR EMAIL
          <span className="flex-1 h-px bg-border" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "signup" && (
            <input
              required
              placeholder="DISPLAY NAME"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full bg-card border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
            />
          )}
          <input
            required type="email" placeholder="EMAIL"
            value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-card border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
          />
          <input
            required type="password" placeholder="PASSWORD" minLength={6}
            value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-card border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
          />
          <button
            type="submit" disabled={busy}
            className="w-full bg-volt text-background font-display text-xl py-4 skew-cta active:scale-95 transition-transform disabled:opacity-60"
          >
            {busy ? "..." : mode === "signin" ? "SIGN IN" : "CREATE ACCOUNT"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="w-full text-center font-mono text-xs uppercase tracking-widest text-foreground/60 hover:text-volt"
        >
          {mode === "signin" ? "New host? Create account" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}
