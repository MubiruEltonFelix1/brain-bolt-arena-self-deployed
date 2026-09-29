import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthState, retryAuthCheck } from "@/lib/auth-state";
import {
  consumeReturnIntent,
  DEFAULT_RETURN_PATH,
  sanitizeReturnPath,
  type ReturnReason,
} from "@/lib/return-intent";
import { toastError } from "@/lib/errors";
import { toast } from "sonner";

const REASONS = ["host", "save-result", "sign-in"] as const;

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  validateSearch: (s: Record<string, unknown>): { next?: string; reason?: ReturnReason } => {
    const next = typeof s.next === "string" ? s.next : undefined;
    const reason = REASONS.includes(s.reason as ReturnReason)
      ? (s.reason as ReturnReason)
      : undefined;
    return { ...(next ? { next } : {}), ...(reason ? { reason } : {}) };
  },
});

/**
 * Contextual copy. `reason` only picks wording - it never grants access, and a
 * crafted `?reason=host` grants exactly nothing.
 */
const COPY: Record<
  ReturnReason,
  { title: string; blurb: string; signIn: string; signUp: string; reassure: string }
> = {
  host: {
    title: "Sign in to host a game",
    blurb: "Create and manage live games from your Brain Bolt account.",
    signIn: "Sign In to Host",
    signUp: "Create Account to Host",
    reassure: "Players still join with a game code — hosting is the only part that needs an account.",
  },
  "save-result": {
    title: "Keep your result",
    blurb: "Sign in or create an account to save your score and track your progress.",
    signIn: "Sign In & Save Result",
    signUp: "Create Account & Save",
    reassure: "We are holding on to your score while you do this.",
  },
  "sign-in": {
    title: "Sign in to Brain Bolt",
    blurb: "Track your scores, save results and host live games.",
    signIn: "Sign In",
    signUp: "Create Account",
    reassure: "Players join with a game code — no account needed to play.",
  },
};

function AuthPage() {
  const navigate = useNavigate();
  const { next, reason } = Route.useSearch();
  const { user, status, initialized } = useAuthState();

  // The intent recorded when the gate fired is the most reliable source: it
  // survives a reload and the OAuth round-trip in the same tab, where the
  // query parameter can be lost. It is consumed on read so it can never
  // become a stale redirect on some later visit.
  const [pendingNext, setPendingNext] = useState<string | null>(null);
  const resolved = useRef(false);

  useEffect(() => {
    const intent = consumeReturnIntent();
    setPendingNext(intent?.path ?? null);
  }, []);

  const copy = COPY[reason ?? "sign-in"];

  /** Only ever an allowlisted internal route, or the dashboard. */
  function destination(): string {
    return sanitizeReturnPath(pendingNext) ?? sanitizeReturnPath(next) ?? DEFAULT_RETURN_PATH;
  }

  function goNext() {
    if (resolved.current) return;
    resolved.current = true;
    void navigate({ to: destination() as never, replace: true });
  }

  // Restore-then-leave. Previously this fired an unguarded `getUser()` and
  // navigated on an async answer, so a slow or failed check could either
  // strand the user or bounce them away mid-flow.
  useEffect(() => {
    if (!initialized) return;
    if (status === "authenticated" && user) goNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, status, user]);

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName || email.split("@")[0] },
            emailRedirectTo: `${window.location.origin}${destination()}`,
          },
        });
        if (error) throw error;

        // Confirmation-required projects return a user with NO session. The
        // old code navigated regardless, which dropped the new account back
        // onto the sign-in form it had just completed.
        if (!data.session) {
          setAwaitingConfirmation(email);
          return;
        }
        toast.success("Account created");
        goNext();
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        goNext();
      }
    } catch (err) {
      const message =
        err instanceof Error && /invalid login credentials/i.test(err.message)
          ? "That email and password combination didn't match."
          : null;
      if (message) setFormError(message);
      else toastError(err, { context: "sign in", fallback: "Could not sign in. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    // Native Supabase OAuth (Lovable's cloud-auth proxy is not available off
    // Lovable). The Google provider must be configured in the Supabase
    // project's Auth settings with this app's domain in the allowed redirect
    // URLs. The pending intent in sessionStorage survives the round-trip, so
    // the return destination does not depend on the redirect URL alone.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}${destination()}` },
    });
    if (error) {
      toastError(error, { context: "google sign in", fallback: "Could not start Google sign-in." });
      setBusy(false);
    }
    // On success the browser leaves for Google and comes back; nothing to do.
  }

  if (awaitingConfirmation) {
    return (
      <AuthFrame title="Check your inbox" blurb={`We sent a confirmation link to ${awaitingConfirmation}.`}>
        <div className="space-y-6">
          <p className="text-sm text-foreground/60">
            Open the link to finish creating your account, then come straight back here. This page will
            take you where you were going.
          </p>
          <button
            onClick={() => {
              setAwaitingConfirmation(null);
              setMode("signin");
            }}
            className="w-full border border-border py-3 font-mono text-xs uppercase tracking-widest text-foreground/60 hover:border-volt hover:text-volt transition-colors"
          >
            Back to sign in
          </button>
        </div>
      </AuthFrame>
    );
  }

  if (!initialized) {
    return (
      <AuthFrame title={copy.title} blurb={copy.blurb}>
        <div
          className="py-8 text-center font-mono text-xs uppercase tracking-widest text-foreground/40"
          role="status"
          aria-busy="true"
        >
          Checking your session…
        </div>
      </AuthFrame>
    );
  }

  if (status === "error") {
    return (
      <AuthFrame title="Connection problem" blurb="We couldn't confirm whether you're signed in.">
        <div className="space-y-6">
          <p className="text-sm text-foreground/60">
            This is usually a dropped connection, not a problem with your account.
          </p>
          <button
            onClick={() => void retryAuthCheck()}
            className="w-full bg-volt text-background font-display text-xl py-4 skew-cta active:scale-95 transition-transform"
          >
            TRY AGAIN
          </button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title={copy.title} blurb={copy.blurb}>
      <div className="space-y-8">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground/45">
          {copy.reassure}
        </p>

        <button
          onClick={handleGoogle}
          disabled={busy}
          aria-busy={busy}
          className="w-full bg-card border border-border py-3 font-mono text-xs uppercase tracking-widest hover:border-volt hover:text-volt transition-colors disabled:opacity-50 min-h-11"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-3 text-foreground/40 text-[10px] font-mono uppercase">
          <span className="flex-1 h-px bg-border" /> OR EMAIL <span className="flex-1 h-px bg-border" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          {formError && (
            <p role="alert" className="border border-pink-shock/30 bg-pink-shock/10 px-4 py-3 font-mono text-xs text-pink-shock">
              {formError}
            </p>
          )}

          {mode === "signup" && (
            <label className="block">
              <span className="sr-only">Display name</span>
              <input
                placeholder="DISPLAY NAME"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-card border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
              />
            </label>
          )}

          <label className="block">
            <span className="sr-only">Email</span>
            <input
              required
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="EMAIL"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-card border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
            />
          </label>

          <label className="block">
            <span className="sr-only">Password</span>
            <input
              required
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              placeholder="PASSWORD"
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-card border border-border py-3 px-4 font-mono text-sm focus:outline-none focus:border-volt"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="w-full bg-volt text-background font-display text-xl py-4 skew-cta active:scale-95 transition-transform disabled:opacity-60 min-h-12"
          >
            {busy
              ? "..."
              : mode === "signin"
                ? copy.signIn
                : copy.signUp}
          </button>
        </form>

        <button
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setFormError(null);
          }}
          disabled={busy}
          className="w-full text-center font-mono text-xs uppercase tracking-widest text-foreground/60 hover:text-volt disabled:opacity-50"
        >
          {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>

        <Link
          to="/"
          className="block text-center font-mono text-[10px] uppercase tracking-widest text-foreground/40 hover:text-volt"
        >
          Back to the arena
        </Link>
      </div>
    </AuthFrame>
  );
}

function AuthFrame({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
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
          <h1 className="font-display text-4xl uppercase italic tracking-tighter">{title}</h1>
          <p className="text-foreground/60 text-sm mt-1">{blurb}</p>
        </div>

        {children}
      </div>
    </div>
  );
}
