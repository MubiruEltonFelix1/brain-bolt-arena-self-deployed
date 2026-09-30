import { expect, test, type Page } from "@playwright/test";
import { adminClient, cleanupLeakedTestUsers, seedFinishedGame, type Seed } from "./seed";

/**
 * The guest result-claim journey, end to end, against a real app and a real
 * database. This is the run that settles whether a guest can actually save a
 * result - the question Phase 9F exists to answer.
 *
 * Before this suite existed, `result_claims` was EMPTY in production while 448
 * guests had finished games. The two explanations were "a guest clicked Save
 * and it silently failed" and "nobody ever clicked it", and nothing in the
 * codebase could tell them apart. These tests run the click.
 */

const SEATS_KEY = "brainbolt:participants";

/** Put the guest seat in the browser, exactly as `saveParticipant` would. */
async function seat(page: Page, seed: Seed) {
  await page.addInitScript(
    ([key, sessionId, identity]) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          [sessionId as string]: identity as unknown as Record<string, never>,
        }),
      );
    },
    [
      SEATS_KEY,
      seed.sessionId,
      { id: seed.meParticipantId, sessionId: seed.sessionId, nickname: seed.nickname, secretToken: seed.meSecret, avatarId: null },
    ] as const,
  );
}

async function signIn(page: Page, seed: Seed) {
  await page.locator('input[type="email"]').fill(seed.email);
  await page.locator('input[type="password"]').fill(seed.password);
  await page.getByRole("button", { name: /sign in & save result/i }).click();
}

test.describe("guest result claim", () => {
  let seed: Seed;

  test.beforeAll(async ({ browser }) => {
    seed = await seedFinishedGame();

    // Warm the dev server's on-demand transform for /play/$sessionId.
    //
    // The results screen is a large client-only route, and the very first cold
    // load of it in a fresh dev server can outlast a test's expect timeout -
    // which reads as a product failure when nothing is actually wrong. Every
    // test after this one runs against a warm server. This is a harness
    // concern, not a claim about how fast the app is in production.
    const warm = await browser.newPage();
    await seat(warm, seed);
    await warm.goto(`/play/${seed.sessionId}`);
    await warm.waitForLoadState("networkidle").catch(() => {});
    await warm.close();
  });

  test.afterAll(async () => {
    // Both paths: the fixture's own teardown, plus a sweep for anything a seed
    // that failed halfway may have left behind.
    await seed?.cleanup();
    await cleanupLeakedTestUsers();
  });

  test("a guest reaches a full result without ever being asked to sign in", async ({ page }) => {
    const authRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/auth/v1/")) authRequests.push(r.url());
    });

    await seat(page, seed);
    await page.goto(`/play/${seed.sessionId}`);

    // The score comes from the stored participant row, not from client state.
    // Scoped to the hero section on purpose: after the redesign the score
    // legitimately appears in four places (the live header, the hero, this
    // player's podium row, and the share card), so an unscoped `getByText`
    // is a strict-mode violation rather than a bug.
    const hero = page.getByRole("region", { name: /your score/i });
    await expect(hero).toBeVisible();
    await expect(hero.getByText("1,500")).toBeVisible();

    // 2200 / 1500 / 800 -> this guest is second.
    await expect(page.getByText(/you finished #2 of 3 players/i)).toBeVisible();

    // A podium, with the guest actually on it.
    await expect(page.getByRole("region", { name: /top three/i })).toBeVisible();
    await expect(page.getByRole("region", { name: /top three/i }).getByText("Runner Up")).toBeVisible();

    // Feedback question must not drag accuracy: 1 of 2 scored is 50%.
    // Scoped for the same reason as the score - the share card repeats these
    // figures, so an unscoped text match is ambiguous by design.
    const perf = page.getByRole("region", { name: /your performance/i });
    await expect(perf.getByText("50%")).toBeVisible();

    // Critically: reading a result is not a reason to authenticate. Every
    // auth request here is a read of the session, never a sign-in.
    expect(authRequests.filter((u) => u.includes("/token"))).toHaveLength(0);
  });

  test("the result survives a full page reload", async ({ page }) => {
    await seat(page, seed);
    await page.goto(`/play/${seed.sessionId}`);
    const hero = page.getByRole("region", { name: /your score/i });
    await expect(hero).toBeVisible();
    const before = await hero.getByText("1,500").textContent();

    await page.reload();

    // Recovered from the database, not from React state.
    await expect(page.getByRole("region", { name: /your score/i })).toBeVisible();
    await expect(page.getByText(/you finished #2 of 3 players/i)).toBeVisible();
    expect(await page.getByRole("region", { name: /your score/i }).getByText("1,500").textContent()).toBe(before);
  });

  test("declining the invitation leaves the result completely intact", async ({ page }) => {
    await seat(page, seed);
    await page.goto(`/play/${seed.sessionId}`);

    const offer = page.getByRole("button", { name: /sign in & save result/i });
    await expect(offer).toBeVisible();
    await page.getByRole("button", { name: /^not now$/i }).click();

    // The invitation is gone; the result is untouched.
    await expect(page.getByRole("button", { name: /sign in & save result/i })).toBeHidden();
    await expect(page.getByRole("heading", { name: /your score/i })).toBeVisible();
    await expect(page.getByText(/you finished #2 of 3 players/i)).toBeVisible();
    await expect(page.getByRole("region", { name: /top three/i })).toBeVisible();
  });

  test("Save Result claims the result, and it is really persisted", async ({ page }) => {
    const db = adminClient();
    const claimPath = "/rest/v1/rpc/create_session_claim";

    await seat(page, seed);
    await page.goto(`/play/${seed.sessionId}`);

    const claimResponse = page.waitForResponse((r) => r.url().includes(claimPath), { timeout: 30_000 });
    await page.getByRole("button", { name: /sign in & save result/i }).click();

    // The ticket must actually be minted, not swallowed into a generic toast.
    const minted = await claimResponse;
    expect(minted.status(), `create_session_claim returned ${minted.status()}: ${await minted.text()}`).toBe(200);

    const { data: tickets } = await db
      .from("result_claims")
      .select("token, kind, claimed_at")
      .eq("participant_id", seed.meParticipantId);
    expect(tickets, "a claim ticket should exist for the guest seat").toHaveLength(1);
    expect(tickets![0].claimed_at).toBeNull();

    // Now authenticate, and the return trip must land back on THIS result.
    await expect(page).toHaveURL(/\/auth\?/);
    expect(page.url()).not.toContain("token");
    await signIn(page, seed);
    await expect(page).toHaveURL(new RegExp(`/play/${seed.sessionId}`));

    // The panel may only say "saved" once the server has confirmed.
    await expect(page.getByText(/saved to your competition history/i)).toBeVisible({ timeout: 45_000 });

    const { data: rows } = await db
      .from("competition_results")
      .select("profile_id, session_id, final_score, final_rank, total_participants, accuracy_percentage")
      .eq("session_id", seed.sessionId);

    expect(rows, "the claimed result must be persisted exactly once").toHaveLength(1);
    expect(rows![0].profile_id).toBe(seed.userId);
    expect(rows![0].final_score).toBe(1500);
    // Authoritative rank for 1500 behind 2200.
    expect(rows![0].final_rank).toBe(2);
    expect(rows![0].total_participants).toBe(3);
    // 1 correct of 2 scored; the feedback question is excluded.
    expect(Number(rows![0].accuracy_percentage)).toBe(50);
  });

  test("a second claim attempt is safely idempotent, never a duplicate row", async ({ page }) => {
    const db = adminClient();

    await seat(page, seed);
    await page.goto(`/play/${seed.sessionId}`);

    // The seat is already linked, so the panel must not offer another save.
    await expect(page.getByText(/saved to your competition history/i)).toBeVisible({ timeout: 45_000 });

    const { data: rows, error: readErr } = await db
      .from("competition_results")
      .select("id")
      .eq("session_id", seed.sessionId);
    // A failed read is not "zero results" - that would let a broken query look
    // like a passing no-duplicates check.
    expect(readErr, `reading competition_results failed: ${readErr?.message}`).toBeNull();
    expect(rows, "a repeat visit must not create a second result").toHaveLength(1);
  });

  test("a player with no seat is told so, and is not pushed to sign in", async ({ page }) => {
    // No seat in localStorage at all.
    await page.goto(`/play/${seed.sessionId}`);
    await expect(page.getByText(/you're not in a game/i)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/play/${seed.sessionId}`));
  });
});
