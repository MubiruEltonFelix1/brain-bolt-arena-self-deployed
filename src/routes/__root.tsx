import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { safeErrorMessage } from "../lib/errors";
import { useAuthState } from "@/lib/auth-state";
import { ClaimRedeemer } from "@/components/ClaimRedeemer";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="font-display text-7xl italic text-volt">404</h1>
        <p className="mt-4 text-sm uppercase tracking-widest font-mono text-foreground/60">
          Signal lost
        </p>
        <Link
          to="/"
          className="mt-6 inline-block bg-volt text-background font-display text-xl px-6 py-3 skew-cta"
        >
          BACK TO ARENA
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="font-display text-3xl uppercase italic text-pink-shock">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-foreground/60">
          {safeErrorMessage(error)}
        </p>
        <button
          onClick={() => { router.invalidate(); reset(); }}
          className="mt-6 min-h-11 bg-volt text-background font-display text-lg uppercase italic px-6 py-3 skew-cta"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "BrainBolt — Real-time quiz arena" },
      { name: "description", content: "Fast, gamified live quiz battles. Solo, team, and league play with real-time scoring." },
      { property: "og:title", content: "BrainBolt — Real-time quiz arena" },
      { property: "og:description", content: "Fast, gamified live quiz battles. Solo, team, and league play with real-time scoring." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "BrainBolt — Real-time quiz arena" },
      { name: "twitter:description", content: "Fast, gamified live quiz battles. Solo, team, and league play with real-time scoring." },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/638338df-810a-43a3-a42b-fc1762ba479a" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/638338df-810a-43a3-a42b-fc1762ba479a" },
    ],
    links: [
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/favicon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head><HeadContent /></head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  const { user, status } = useAuthState();

  // The app has exactly ONE `onAuthStateChange` subscription, owned by
  // `src/lib/auth-state.ts`. The root reacts to the resolved identity by
  // re-running the router and the query cache, so no component needs its own
  // listener. The first transition out of `loading` always counts: anything
  // that needed the identity had no chance to see it before.
  const settled = useRef(false);
  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    if (status === "loading") return;
    const id = user?.id ?? null;
    if (settled.current && lastUserId.current === id) return;
    settled.current = true;
    lastUserId.current = id;
    // Only a real identity invalidates cached data. Signing out still
    // invalidates the router so anything auth-dependent re-runs as a guest.
    if (id) void queryClient.invalidateQueries();
    void router.invalidate();
  }, [user?.id, status, router, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <ClaimRedeemer />
      <Toaster theme="dark" position="top-center" />
    </QueryClientProvider>
  );
}
