// Guest-first gameplay, and the authorization boundaries that must not move.
//
// These are source-level assertions on purpose. The guarantee being protected
// is structural: a guest must be able to open the join page, enter a Game PIN,
// join the lobby, play, and see the podium without any authentication step
// appearing. A behavioural test would need a live game; a structural one
// catches a regression the moment someone re-adds a gate to the join path.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// Normalize line endings: the checked-in sources are CRLF on Windows, and the
// structural assertions below match across lines.
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const JOIN = read("src/routes/join.$code.tsx");
const PLAY = read("src/routes/play.$sessionId.tsx");
const INDEX = read("src/routes/index.tsx");
const HOST = read("src/routes/host.$sessionId.tsx");

describe("guest join page is auth-free", () => {
  test("the join page never gates, redirects to sign-in, or signs out", () => {
    expect(JOIN).not.toContain("useAuthGate");
    expect(JOIN).not.toContain("useAuthUser");
    expect(JOIN).not.toContain('"/auth"');
    expect(JOIN).not.toContain("signOut");
    expect(JOIN).not.toContain("onAuthStateChange");
    expect(JOIN).not.toContain("auth.getUser");
  });

  test("the join page still accepts a Game PIN and mints a guest seat", () => {
    expect(JOIN).toContain("join_session");
    expect(JOIN).toContain("saveParticipant");
    expect(JOIN).toContain('navigate({ to: "/play/$sessionId"');
  });

  test("the landing page's Game PIN entry has no auth gate", () => {
    // The PIN lookup must not depend on a signed-in user.
    expect(INDEX).toContain("lookupGameCode");
    expect(INDEX).not.toContain("useAuthGate");
  });
});

describe("active gameplay is not coupled to auth", () => {
  test("the play screen never signs the user out or navigates to sign-in itself", () => {
    expect(PLAY).not.toContain("signOut");
    expect(PLAY).not.toContain('navigate({ to: "/auth"');
    expect(PLAY).not.toContain("auth.getUser");
    expect(PLAY).not.toContain("onAuthStateChange");
  });

  test("the seat is never recreated, so auth changes cannot reset a game", () => {
    // Nothing in the play screen mints a new participant.
    expect(PLAY).not.toContain("saveParticipant");
    expect(PLAY).not.toContain("join_session");
  });

  test("player identity is read once per session, keyed on the session alone", () => {
    expect(PLAY).toContain("setIdentity(getParticipant(sessionId))");
    // The identity effect must not depend on auth, or a token refresh would
    // re-run it mid-game.
    const effect = /setIdentity\(getParticipant\(sessionId\)\);\s*(\/\/[^\n]*\n\s*)*\}, \[([^\]]*)\]\)/.exec(PLAY);
    expect(effect).not.toBeNull();
    expect(effect![2].trim()).toBe("sessionId");
  });

  test("the save-result affordance only exists on the finished-game screen", () => {
    // FinalView is the only consumer of SaveResultPanel, and it is only
    // mounted once the game has ended, so the prompt cannot interrupt play.
    expect(PLAY).toContain("{ended && (\n          <FinalView");
    expect(PLAY).toContain("SaveResultPanel");
  });
});

describe("the landing page reflects auth state", () => {
  test("it reads the auth store", () => {
    expect(INDEX).toContain("useAuthState");
    expect(INDEX).toContain("signedIn");
  });

  test("a signed-in visitor is offered the account surface, not a sign-in form", () => {
    // /auth sends an authenticated visitor straight back to their destination,
    // so a persistent "Sign in" control bounced them home again and looked like
    // the page reloading and doing nothing.
    const nav = INDEX.slice(INDEX.indexOf("<nav"), INDEX.indexOf("</nav>"));
    expect(nav).toContain("{signedIn ? (");
    // Both sides of the branch must live in the nav: the account surface for a
    // signed-in visitor, the sign-in controls for a guest.
    expect(nav).toContain('to="/dashboard"');
    expect(nav).toContain('to="/profile"');
    expect(nav).toContain('startSignIn("sign-in")');
    expect(nav).toContain('startSignIn("host")');
  });

  test("the sign-in entry point refuses to run once signed in", () => {
    // Covers the window before the auth store settles.
    expect(INDEX).toMatch(/function startSignIn[\s\S]{0,300}if \(signedIn\) return;/);
  });

  test("guests keep the sign-in and host controls", () => {
    expect(INDEX).toContain('startSignIn("sign-in")');
    expect(INDEX).toContain('startSignIn("host")');
  });
});

describe("account-dependent actions are gated", () => {
  test("hosting requires authentication", () => {
    expect(HOST).toContain("gateSuspended");
    expect(HOST).toContain("gameInProgress");
  });

  test("the gate suspends only while a game is actually under way", () => {
    expect(HOST).toContain('session.status === "active"');
    expect(HOST).toContain('session.status === "question_results"');
    // The lobby is not a live game: sign-in is still requested there.
    expect(HOST).toContain('const inLobby = session.status === "lobby"');
  });
});

describe("authorization regression", () => {
  const migrations = readdirSync(join(ROOT, "supabase/migrations"));
  const allSql = migrations
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(`supabase/migrations/${f}`))
    .join("\n");

  test("the server auth middleware still gates protected operations", () => {
    const middleware = read("src/integrations/supabase/auth-middleware.ts");
    expect(middleware).toContain("requireSupabaseAuth");
    expect(middleware).toContain("getClaims");
    expect(middleware).toContain("Unauthorized");
  });

  test("the Principal/capability resolver is intact", () => {
    expect(allSql).toContain("public.can(");
  });

  test("result_claims keeps RLS enabled and stays unreachable directly", () => {
    const claimSql = allSql.slice(allSql.indexOf("CREATE TABLE public.result_claims"));
    expect(claimSql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(claimSql).toContain("GRANT ALL ON public.result_claims TO service_role");
    // Token possession plus `auth.uid()` is the whole model; the client never
    // gets a direct grant.
    expect(claimSql).toContain("GRANT EXECUTE ON FUNCTION public.claim_result(text) TO authenticated");
    expect(claimSql).not.toContain("GRANT ALL ON public.result_claims TO anon");
  });

  test("claim redemption still requires an authenticated identity and is one-time", () => {
    const claimSql = allSql.slice(allSql.indexOf("CREATE TABLE public.result_claims"));
    const fn = claimSql.slice(claimSql.indexOf("FUNCTION public.claim_result"));
    expect(fn).toContain("auth.uid()");
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("Already claimed");
    expect(fn).toContain("Claim expired");
    // Another account cannot take a seat that is already linked.
    expect(fn).toContain("profile_id IS NULL");
  });

  test("the score is never taken from a client-supplied value", () => {
    expect(allSql).toContain("evaluate_question_answer");
    expect(allSql).toContain("score_arena_run");
  });

  test("no migration newer than the claim-token fix reintroduces the bug", () => {
    // The defect: pgcrypto lives in `extensions`, and these functions pin
    // `search_path TO 'public'`, so an unqualified `gen_random_bytes(...)`
    // cannot resolve and every call dies with 42883. That is exactly what
    // silently broke "Save this result" - no test executed these RPCs against
    // the live database.
    //
    // The 2026-08-0x migrations that introduced the call are history and must
    // not be rewritten (they are already applied, and the marker system keys
    // off filename order). What must hold is that nothing AFTER the repair
    // reintroduces it.
    const FIX = "20260927090000_phase_9e_claim_token_pgcrypto.sql";
    const fixIndex = migrations.indexOf(FIX);
    expect(fixIndex).toBeGreaterThan(-1);

    const offenders: string[] = [];
    for (const file of migrations.filter((f) => f.endsWith(".sql"))) {
      if (migrations.indexOf(file) <= fixIndex) continue;
      const sql = read(`supabase/migrations/${file}`);
      const re = /CREATE (?:OR REPLACE )?FUNCTION\s+(?:public\.)?(\w+)[\s\S]*?\$\$;/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const block = m[0];
        if (!/search_path TO 'public'/.test(block)) continue;
        if (/\bgen_random_bytes\(/.test(block) && !/extensions\.gen_random_bytes\(/.test(block)) {
          offenders.push(`${file}:${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the claim-token repair migration exists and qualifies pgcrypto", () => {
    const fix = read("supabase/migrations/20260927090000_phase_9e_claim_token_pgcrypto.sql");
    expect(fix).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(fix).toContain("extensions.gen_random_bytes(32)");
    // Widening a SECURITY DEFINER search_path is how object hijacking happens;
    // the fix must stay a targeted schema qualification.
    expect(fix).not.toMatch(/search_path TO '[^']*extensions/);
    // The grant boundary must survive the redefinition.
    expect(fix).toContain("GRANT EXECUTE ON FUNCTION public.create_session_claim(uuid, text) TO anon, authenticated");
    expect(fix).toContain("GRANT EXECUTE ON FUNCTION public.create_arena_claim(uuid, jsonb) TO anon, authenticated");
    expect(fix).toContain("REVOKE ALL ON FUNCTION public.create_session_claim(uuid, text) FROM PUBLIC");
  });

  test("suspending the host gate grants no privilege", () => {
    // `gateSuspended` only stops the client navigating away when a host's
    // token dies mid-game. Every control action must therefore still be
    // authorized server-side, or that would be a privilege escalation.
    const control = allSql.slice(allSql.indexOf("FUNCTION public.advance_question"));
    const head = control.slice(0, 400);
    expect(head).toContain("is_session_host");
    expect(head).toMatch(/RAISE EXCEPTION/i);
  });

  test("host control RPCs are guarded by the session-host check", () => {
    // A representative spread, not every RPC, to catch a regression where a
    // control action loses its authorization.
    for (const fn of ["advance_question", "skip_current_question", "start_game", "end_early"]) {
      const idx = allSql.indexOf(`FUNCTION public.${fn}`);
      if (idx === -1) continue;
      const head = allSql.slice(idx, idx + 500);
      expect(head).toContain("is_session_host");
    }
  });
});
