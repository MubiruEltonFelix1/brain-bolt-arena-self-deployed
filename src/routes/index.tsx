import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { describeGameCode, lookupGameCode, type GameCodeLookup } from "@/lib/game-code";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lookup, setLookup] = useState<GameCodeLookup | null>(null);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.replace(/\D/g, "");
    if (clean.length < 4) {
      toast.error("Enter the whole Game PIN", {
        description: "Your host's Game PIN is the number on their screen.",
      });
      return;
    }
    setSubmitting(true);
    setLookup(null);
    let info: GameCodeLookup | null = null;
    try {
      info = await lookupGameCode(clean);
    } catch {
      setSubmitting(false);
      toast.error("We couldn't check that Game PIN", {
        description: "Check your connection and try again.",
      });
      return;
    }
    setSubmitting(false);
    if (!info) {
      toast.error("No game found with that PIN", {
        description: "Check the digits on the host's screen and try again.",
      });
      return;
    }
    if (info.session_status === "ended") {
      setLookup(info);
      toast.error("That game has already finished", {
        description: "Ask your host to start a new one.",
      });
      return;
    }
    // A scheduled competition whose lobby is open behaves exactly like a hosted
    // lobby — we only explain the difference, we never fork the flow.
    setLookup(info);
    navigate({ to: "/join/$code", params: { code: clean } });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-md border-b border-border">
        <Link to="/" className="flex items-center gap-2">
          <div className="size-8 bg-volt grid place-items-center skew-x-[-12deg]">
            <span className="font-display text-background text-xl italic">B</span>
          </div>
          <span className="font-display text-2xl tracking-tight italic">BRAINBOLT</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link
            to="/arena"
            className="font-mono text-xs uppercase text-foreground/60 hover:text-volt hidden sm:inline"
          >
            Arena
          </Link>
          <Link
            to="/auth"
            className="font-mono text-xs uppercase text-foreground/60 hover:text-volt"
          >
            Sign in
          </Link>
          <Link
            to="/auth"
            className="px-4 py-1.5 border border-volt text-volt font-mono text-xs hover:bg-volt hover:text-background transition-colors uppercase"
          >
            Host
          </Link>
        </div>
      </nav>

      <main className="max-w-md mx-auto px-6 pt-12 pb-32 space-y-16">
        <section className="space-y-8 animate-float">
          <div className="space-y-2">
            <h1 className="font-display text-6xl leading-[0.9] tracking-tighter uppercase italic">
              JOIN A<br />
              <span className="text-volt">LIVE GAME</span>
            </h1>
            <p className="text-foreground/60 font-mono text-sm tracking-wide uppercase">
              Speed + accuracy. Solo, teams, leagues.
            </p>
          </div>

          <form onSubmit={handleJoin} className="space-y-4">
            <label htmlFor="game-pin" className="block">
              <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/60">
                Game Pin — from your host&apos;s screen
              </span>
              <input
                id="game-pin"
                type="text"
                inputMode="numeric"
                maxLength={8}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                aria-label="Game PIN"
                className="mt-2 w-full bg-card border-2 border-border py-6 px-8 text-4xl font-display tracking-[0.2em] text-center focus:outline-none focus:border-volt transition-all uppercase animate-join"
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-16 bg-volt text-background font-display text-2xl uppercase italic py-5 skew-cta active:scale-95 transition-transform disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
            >
              {submitting ? "Joining game…" : "Join Game"}
            </button>
            {lookup && (
              <div
                role="status"
                className="border border-border bg-card p-4 text-left space-y-1"
              >
                <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
                  {describeGameCode(lookup).label}
                </p>
                <p className="text-sm text-foreground/75">{describeGameCode(lookup).detail}</p>
              </div>
            )}
            <Link
              to="/request-hosting"
              className="block w-full text-center border border-border py-4 font-mono text-xs uppercase tracking-widest text-foreground/60 hover:text-volt hover:border-volt transition-colors"
            >
              Request hosting access
            </Link>
          </form>
        </section>

        <section className="animate-float [animation-delay:60ms]">
          <div className="relative bg-card border-2 border-cyan-jolt p-6 overflow-hidden">
            <div className="absolute -top-8 -right-8 size-32 bg-cyan-jolt/10 blur-3xl pointer-events-none" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-cyan-jolt">
              Start here · No sign-up
            </p>
            <h2 className="mt-1 font-display text-3xl italic uppercase tracking-tight">
              Training <span className="text-cyan-jolt">Arena</span>
            </h2>
            <p className="mt-2 text-foreground/70 text-sm">
              New to BrainBolt? Try every question type in under 2 minutes — no
              code, no account.
            </p>
            <Link
              to="/training"
              className="mt-5 block w-full text-center bg-cyan-jolt text-background font-display text-xl uppercase italic py-4 skew-cta active:scale-95 transition-transform"
            >
              Try the Training Arena
            </Link>
          </div>
        </section>

        <section className="animate-float [animation-delay:75ms]">
          <div className="relative bg-card border-2 border-volt p-6 overflow-hidden">
            <div className="absolute -top-8 -left-8 size-32 bg-volt/10 blur-3xl pointer-events-none" />
            <p className="font-mono text-[10px] uppercase tracking-widest text-volt">
              Solo · Brain Bolt Arena
            </p>
            <h2 className="mt-1 font-display text-3xl italic uppercase tracking-tight">
              Play <span className="text-volt">Arena</span>
            </h2>
            <p className="mt-2 text-foreground/70 text-sm">
              Play solo at your own pace, chase your personal best, and climb the
              Arena challenges.
            </p>
            <Link
              to="/arena"
              className="mt-5 block w-full text-center bg-volt text-background font-display text-xl uppercase italic py-4 skew-cta active:scale-95 transition-transform"
            >
              Play Arena
            </Link>
            <Link
              to="/auth"
              className="mt-3 block text-center font-mono text-[10px] uppercase tracking-widest text-foreground/50 hover:text-volt"
            >
              Sign up to save your scores →
            </Link>
          </div>
        </section>



        <section className="space-y-6 animate-float [animation-delay:150ms]">
          <div className="flex justify-between items-end border-l-4 border-volt pl-4">
            <h2 className="font-display text-2xl italic tracking-tight uppercase">How it works</h2>
            <span className="font-mono text-xs text-volt">3 STEPS</span>
          </div>
          <div className="grid gap-3">
            {[
              ["01", "Your host starts a game", "They pick a quiz and put the Game PIN on screen."],
              ["02", "You join with the PIN", "Any phone, tablet or laptop. No account needed."],
              ["03", "Answer fast, score higher", "The leaderboard updates after every question."],
            ].map(([n, title, sub]) => (
              <div key={n} className="bg-card border border-border p-5 flex items-start gap-4">
                <span className="font-display text-3xl italic text-volt">{n}</span>
                <div>
                  <p className="font-bold">{title}</p>
                  <p className="text-foreground/60 text-sm">{sub}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-6 animate-float [animation-delay:300ms]">
          <div className="flex justify-between items-end border-l-4 border-pink-shock pl-4">
            <h2 className="font-display text-2xl italic tracking-tight uppercase">Modes</h2>
            <span className="font-mono text-xs text-pink-shock">3</span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <ModePill name="Solo Sprint" desc="Pure speed, every player for themselves" color="volt" />
            <ModePill name="Team Clash" desc="Squad scores aggregate live" color="cyan-jolt" />
            <ModePill name="League" desc="Persistent standings across recurring nights" color="pink-shock" />
          </div>
        </section>
      </main>

    </div>
  );
}

function ModePill({ name, desc, color }: { name: string; desc: string; color: string }) {
  return (
    <div className="bg-card border border-border p-5 flex items-center gap-4">
      <div className={`size-12 bg-${color}/15 border border-${color}/30 grid place-items-center skew-x-[-12deg]`}>
        <div className={`size-3 bg-${color}`}></div>
      </div>
      <div className="flex-1">
        <p className="font-bold">{name}</p>
        <p className="text-foreground/60 text-xs">{desc}</p>
      </div>
    </div>
  );
}
