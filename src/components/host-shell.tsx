import { Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useHostStatus } from "@/hooks/use-host-status";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

// Authorization is evaluated exclusively through `useHostStatus`, which reads
// the central role table. No email or client-side constant grants access.

/**
 * A single navigation model drives both breakpoints.
 * `primary` destinations stay inline on mobile; everything else collapses into
 * the overflow menu so the bar never wraps or clips below 430px.
 */
const NAV_ITEMS = [
  { to: "/dashboard", label: "Quizzes", primary: true },
  { to: "/competitions", label: "Competitions", primary: true },
  { to: "/leagues", label: "Leagues", primary: false },
  { to: "/branding", label: "Branding", primary: false },
  { to: "/arena", label: "Arena", primary: false },
  { to: "/profile", label: "Profile", primary: false },
] as const;

const linkClass =
  "font-mono text-xs uppercase text-foreground/70 hover:text-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt transition-colors";

export function HostShell({ children, title }: { children: ReactNode; title?: string }) {
  const { user, isAdmin, canHost, loading } = useHostStatus();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  // Close the overflow menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function signOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/" });
  }

  if (loading || !user) {
    return (
      <div
        className="min-h-screen grid place-items-center font-mono text-foreground/50 text-sm"
        aria-busy="true"
      >
        LOADING...
      </div>
    );
  }

  // Signed-in users without hosting authorization still reach the dashboard,
  // where a card explains the state. The admin always passes.
  void canHost;

  const overflow = NAV_ITEMS.filter((i) => !i.primary);

  return (
    <div className="min-h-screen bg-background">
      <nav
        aria-label="Main"
        className="sticky top-0 z-50 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 sm:px-6 py-3 bg-background/85 backdrop-blur-md border-b border-border"
      >
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2">
          <div className="size-7 shrink-0 bg-volt grid place-items-center skew-x-[-12deg]">
            <span className="font-display text-background text-base italic">B</span>
          </div>
          <span className="font-display text-xl italic tracking-tight">BRAINBOLT</span>
          {title && (
            <span className="font-mono text-xs uppercase text-foreground/40 ml-3 hidden lg:inline truncate">
              / {title}
            </span>
          )}
        </Link>

        <div className="flex items-center gap-2 sm:gap-4">
          {/* Desktop: the full set stays inline and efficient. */}
          <div className="hidden md:flex items-center gap-4">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={linkClass}
                activeProps={{ className: "font-mono text-xs uppercase text-volt" }}
              >
                {item.label}
              </Link>
            ))}
            {isAdmin && (
              <Link to="/admin" className={`${linkClass} text-pink-shock`}>
                Admin
              </Link>
            )}
            <button onClick={signOut} className={`${linkClass} text-foreground/50 hover:text-pink-shock`}>
              Sign out
            </button>
          </div>

          {/* Mobile: two priority destinations inline, the rest in one menu. */}
          <div className="flex md:hidden items-center gap-2">
            {NAV_ITEMS.filter((i) => i.primary).map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`${linkClass} inline-flex min-h-11 items-center px-2`}
                activeProps={{ className: "font-mono text-xs uppercase text-volt inline-flex min-h-11 items-center px-2" }}
              >
                {item.label === "Competitions" ? "Comps" : item.label}
              </Link>
            ))}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label="More navigation"
                className="inline-flex min-h-11 min-w-11 items-center justify-center border border-border px-3 font-mono text-xs uppercase text-foreground/70 hover:border-volt hover:text-volt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt"
              >
                More
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+0.5rem)] w-52 bg-card border-2 border-border shadow-xl p-1"
                >
                  {overflow.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="block px-3 py-3 font-mono text-xs uppercase text-foreground/80 hover:bg-volt hover:text-background focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-volt"
                    >
                      {item.label}
                    </Link>
                  ))}
                  {isAdmin && (
                    <Link
                      to="/admin"
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="block px-3 py-3 font-mono text-xs uppercase text-pink-shock hover:bg-pink-shock hover:text-background"
                    >
                      Admin
                    </Link>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); signOut(); }}
                    className="block w-full text-left px-3 py-3 font-mono text-xs uppercase text-foreground/60 hover:bg-border"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>
      <main>{children}</main>
    </div>
  );
}
