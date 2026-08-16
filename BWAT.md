# BWAT.md

This file provides guidance to Bwat when working with code in this repository.

## Tech Stack

- **Framework**: TanStack Start v1 — SSR on Cloudflare Workers (Nitro), file-based routing, server logic via `createServerFn` (NOT Supabase Edge Functions)
- **Frontend**: React 19 + TypeScript (strict), TanStack Router + Query
- **Build**: Vite 8 via `@lovable.dev/vite-tanstack-config` wrapper; package manager is **Bun** (`bun.lock`, `bun run …`)
- **Styling**: Tailwind CSS v4 (CSS-first config in `src/styles.css`, no `tailwind.config.*`), shadcn/ui (new-york style, `components.json`), Radix UI primitives, lucide-react icons
- **Backend**: Supabase — Auth (Email + Google OAuth), Postgres with RLS, Realtime (broadcast websockets)
- **Other**: zod, react-hook-form, Leaflet/react-leaflet (map questions), Recharts, dnd-kit (ordering), html-to-image (share cards), sonner, vaul, qrcode.react

## Brand Identity

**Colors** (tokens in `src/styles.css`, oklch values, dark-only app):
- Primary / volt: `oklch(0.95 0.24 125)` (#CCFF00 volt green) — also ring color, `::selection`
- Accent / pink-shock: `oklch(0.7 0.25 13)` (#FF2D55) — also destructive
- cyan-jolt: `oklch(0.85 0.15 200)`; amber-spark: `oklch(0.85 0.18 80)`
- Background: `oklch(0.13 0.005 270)` (#0A0A0C); card/popover: `oklch(0.19 0.008 270)` (#1E1E22)
- Foreground: `oklch(0.96 0.005 270)` (#F4F4F5); border: `oklch(1 0 0 / 10%)`
- Used as Tailwind classes: `bg-volt`, `text-volt`, `border-volt`, `bg-pink-shock`, `text-cyan-jolt`, `bg-background`, `text-foreground`, `text-foreground/60`, etc.

**Typography**:
- Display: Anton (`font-display`, typically uppercase, often italic)
- Body: Inter (`font-sans`); Mono: JetBrains Mono (`font-mono`, used for codes/labels)

**Geometry**:
- Border radius: `0.25rem` (`--radius`) — sharp corners
- Spacing: default Tailwind v4 scale
- Custom utilities: `skew-cta` (skewX(-4deg) CTA buttons), `animate-join`, `animate-float`, `animate-burst`, `animate-wrong`

**Visual language**: "Esports broadcast, high voltage" — near-black arena, skewed volt-green CTAs, condensed uppercase display headings, sharp corners, one neon accent per question type.

## Coding Conventions

- `@/*` alias → `src/*` (aliases: `@/components`, `@/lib`, `@/hooks`, `@/components/ui`)
- **Routing**: every `.tsx` in `src/routes/` is a route (see `src/routes/README.md`). Dynamic params are bare `$id` (no curly braces), splat is `$.tsx`, layouts render `<Outlet />`, root shell is `__root.tsx`. `routeTree.gen.ts` is auto-generated — never hand-edit.
- **Server-only code** lives in `.server.ts` files. Never top-level-import `supabaseAdmin` in route files or `*.functions.ts` — they ship to the client bundle; use `await import("@/integrations/supabase/client.server")` inside handlers. Same for any other server-only module.
- **Env access**: read `process.env` inside functions/handlers, never at module scope (Cloudflare Workers bind env at request time). `import.meta.env.VITE_*` is public and ships to the browser.
- **Server logic** = `createServerFn({ method: "POST" })` with `.inputValidator(z.object(...))` — the pattern in `src/lib/api/example.functions.ts`. No Edge Functions.
- **Auto-generated Supabase files** (`client.ts`, `client.server.ts`, `auth-middleware.ts`, `types.ts` in `src/integrations/supabase/`) — do not edit directly.
- **vite.config.ts**: do NOT add tanstackStart/viteReact/tailwindcss/tsConfigPaths/nitro/componentTagger plugins — `@lovable.dev/vite-tanstack-config` already includes them; duplicates break the build.
- **Question types are registry-driven**: adding one means an entry in `src/lib/question-registry.ts` (QuestionTypeDef: answerKind, scored, media, accent) + a body in `src/components/question/QuestionBodies.tsx` + CSV import support. Pure grading helpers (haversineKm, orderingRatio, geoRatio, numberRatio) live in the registry.
- No hardcoded colors — use the tokens (volt / pink-shock / cyan-jolt / amber-spark / background / foreground / card / muted / border).
- ESLint flat config + Prettier (eslint-plugin-prettier); `bun run format` writes, `bun run lint` checks.
- Tailwind v4 CSS-first: theme tokens go in `src/styles.css` (`@theme` block), never a `tailwind.config.*` file.

## Architecture Notes

- **Realtime quiz engine**: host runs a session over Supabase Realtime broadcast channels; players join via 6-digit code (`generateGameCode`) or `/join/<code>`; every question starts with a 5s reveal (`INTRO_DURATION_MS = 5000` in question-registry.ts); host controls reveal/skip/advance with optional auto-advance. All realtime subscriptions go through `useLiveChannel` (`src/hooks/use-live-channel.ts`): exactly one channel per mount, exponential-backoff reconnect, and **re-read authoritative server state on reconnect — never replay missed events**.
- **Scoring** is centralized in `src/lib/game.ts` (`BASE_POINTS = 1000`, speed bonus scaled by response time, streak multiplier up to +50%) and shared by host, player, Arena, and Training surfaces.
- **Auth**: client-side gating via `useAuthUser` hook; server-side via `requireSupabaseAuth` middleware (`auth-middleware.ts`, Bearer-token, injects `supabase` + `userId` into context). Player join is token-based (`generateToken` + `src/lib/participant-storage.ts`) — no account needed to play.
- **Authorization is Postgres-side**: capability resolver `public.can(principal, action, resource)` + `user_roles` table + `current_principal_id()`/`principal_for_user()`/`has_role()` helpers; RLS on every table. Role checks are never client-only. Recent migrations moved ownership onto a `principals` identity table with `owner_principal_id` sync triggers — keep the principal-aware pattern (legacy `owner_id` fallback retained) when writing new policies.
- **SSR error handling**: `src/server.ts` is the server entry (wired in vite.config as `server.entry: "server"`). h3 swallows in-handler throws into a JSON 500 body; `normalizeCatastrophicSsrResponse` converts those to the rendered error page. `src/lib/error-capture.ts` must stay the first import there.
- App shell is **dark-only**: `__root.tsx` hardcodes `className="dark"` on `<html>`.

## Commands

- `bun install` / `bun run dev` / `bun run preview`
- `bun run build` (production) / `bun run build:dev` (development-mode build)
- `bun run lint` / `bun run format`
- No test suite script is defined.
- DB schema lives in `supabase/migrations/*.sql`. Apply it with `bun scripts/migrate.mjs` (connects via `DATABASE_URL` from `.env` using psql; reports applied/pending and applies pending ones automatically, each in its own transaction, in filename order, stopping on the first failure). `bun scripts/migrate.mjs --dry-run` reports only. `bun scripts/check-migrations.mjs` is the read-only status report.

## Gotchas

- **`.env.example` does not exist** despite README instructions to copy it. Client env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`. Server env: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Configure via Lovable Cloud.
- **Brand accent opacity classes are limited**: only the combinations enumerated in the `@source inline("...")` declaration at the top of `src/styles.css` exist (e.g. `bg-volt/5 /10 /15 /20`, `text-volt`, `border-volt/30`, `shadow-volt/30`, and the pink-shock / cyan-jolt / amber-spark equivalents). They're listed there because they're used in dynamic class maps — `bg-${accent}`-style string interpolation will NOT compile. Add new combos to that inline list if you need them.
- **bunfig.toml** sets `minimumReleaseAge = 86400`: packages published less than 24h ago fail to install. Exceptions go in `minimumReleaseAgeExcludes` — confirm with the user before adding one.
- Both `bun.lock` and `package-lock.json` exist — always use `bun`; running npm installs can drift the lockfiles.
- README says "Vite 7" but package.json pins `vite: ^8.0.16` — package.json is authoritative.
- `#lovable-badge` is intentionally hidden in styles.css — don't remove that rule.
- **Migration markers are mandatory**: the live DB has no `supabase_migrations` ledger, so applied/pending is judged by schema markers — every migration in `supabase/migrations/` needs a probe entry in `scripts/migration-markers.mjs` (single source of truth for `migrate.mjs` and `check-migrations.mjs`). A migration without an entry is never auto-applied (the runner blocks with exit 1).
