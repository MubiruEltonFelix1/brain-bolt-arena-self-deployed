#!/usr/bin/env bun
// scripts/auth-journey.mjs — Phase 9E end-to-end browser verification.
//
// Drives a REAL Chromium against the production bundle to exercise the two
// journeys the phase was written for, plus the specific regressions it fixed:
//
//   A  Guest -> Game PIN -> Lobby -> Play -> Finish -> Save Result
//      -> Sign In -> Return -> Claim -> Saved Confirmation
//   B  Unauthenticated -> Host a Game -> Sign In -> Return to Host flow
//   C  Landing nav: typed-in Game PIN survives a voluntary sign-in
//   D  Sign-out ends the session and re-gates the dashboard
//   E  Mobile (Pixel 8 emulation) repeats journey A
//
// It also asserts the handoff is a CLIENT-SIDE navigation, not a full document
// reload: a marker planted on `window` before the handoff must still be there
// afterwards. A full reload is exactly the defect that discarded the results
// view, so that is the load-bearing assertion of the whole run.
//
// Each journey gets its OWN browser context, because pages on one browser
// share an origin's localStorage - and a leftover guest seat makes the join
// page short-circuit straight to /play, which would silently skip the lobby.
//
// Prerequisites (all reuse the Phase 9D harness):
//   bun scripts/scale-audit/fixture.mjs create       # scratch quiz + session
//   bun scripts/scale-audit/create-auth-user.mjs     # throwaway confirmed host
//   bun scripts/scale-audit/serve.mjs                # nitro on :3000
//   bun scripts/auth-journey.mjs
//
// Cleanup: `bun scripts/scale-audit/fixture.mjs cleanup` removes the scratch
// quiz, session, participants and the throwaway auth user.

import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, globSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadEnv } from "./migration-markers.mjs";

const HERE = import.meta.dir;
const AUDIT = join(HERE, "scale-audit");
const BASE = process.env.BASE_URL || "http://localhost:3000";

const vars = { ...loadEnv(join(ROOT, ".env")), ...process.env };
const admin = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const fixture = JSON.parse(readFileSync(join(AUDIT, "fixture.json"), "utf8"));
const account = JSON.parse(readFileSync(join(AUDIT, "auth-user.json"), "utf8"));

const results = [];
let currentJourney = "";
const step = (m) => console.log(`   . ${m}`);

function check(name, pass, detail = "") {
  results.push({ journey: currentJourney, name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function chromePath() {
  const base = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  for (const rel of [
    "chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chromium-*/chrome-win/chrome.exe",
    "chrome-win/chrome.exe",
  ]) {
    const hit = globSync(join(base, rel))[0];
    if (hit && existsSync(hit)) return hit;
  }
  for (const p of [
    join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium found. Install Playwright chromium or Chrome.");
}

const body = (page) => page.evaluate(() => document.body.innerText);
const path = (page) => new URL(page.url()).pathname;

/**
 * The session must be in the right lifecycle state per journey: `lobby` to
 * accept joins, `ended` to render the results view (and for the server to
 * write the competition_results row during redemption).
 */
async function setStatus(status) {
  const { error } = await admin.from("sessions").update({ status }).eq("id", fixture.sessionId);
  if (error) throw new Error(`set status ${status}: ${error.message}`);
  await new Promise((r) => setTimeout(r, 500));
}

/** Remove seats left by an earlier run so counts and nicknames are unambiguous. */
async function clearProbeSeats() {
  const { data } = await admin
    .from("participants")
    .select("id")
    .eq("session_id", fixture.sessionId)
    .in("nickname", ["AuthProbe", "MobileProbe"]);
  const ids = (data ?? []).map((p) => p.id);
  if (!ids.length) return 0;
  await admin.from("participant_secrets").delete().in("participant_id", ids);
  await admin.from("participants").delete().in("id", ids);
  await admin.from("result_claims").delete().in("participant_id", ids);
  // competition_results is UNIQUE(profile_id, session_id) and the claim does
  // ON CONFLICT DO NOTHING, so a row from an earlier run would make the
  // "exactly one row" assertion pass on stale data.
  await admin
    .from("competition_results")
    .delete()
    .eq("session_id", fixture.sessionId)
    .eq("profile_id", account.userId);
  return ids.length;
}

async function waitForText(page, needle, timeout = 20000) {
  await page.waitForFunction(
    (n) => document.body.innerText.toUpperCase().includes(n.toUpperCase()),
    { timeout },
    needle,
  );
}

async function signIn(page) {
  await page.waitForSelector("input[type=email]", { timeout: 25000 });
  await page.type("input[type=email]", account.email);
  await page.type("input[type=password]", account.password);
  await page.click("button[type=submit]");
}

/**
 * Assert nothing pushed the player toward a sign-in wall.
 *
 * `allowSaveOffer` is for the FINISHED-game screen, where the "Keep your
 * result" affordance is required by design and is user-initiated. It is never
 * set for the lobby or active gameplay, where any such prompt is a defect.
 */
async function assertNoAuthPrompt(page, label, { allowSaveOffer = false } = {}) {
  const url = page.url();
  const text = await body(page);
  const onAuth = new URL(url).pathname === "/auth";
  const blocked = /sign in to host|sign in & save|create account to host/i.test(text);
  const saveOffer = /keep your result|save this result/i.test(text);
  const bad = onAuth || blocked || (saveOffer && !allowSaveOffer);
  check(
    `${label}: no sign-in prompt`,
    !bad,
    onAuth ? `redirected to ${url}` : blocked ? "blocking sign-in copy present" : saveOffer ? "save offer shown" : "",
  );
}

/** Land on the join page, pick a nickname, and reach the play screen. */
async function joinAsGuest(page, nickname) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await page.type("#game-pin", fixture.code);
  await page.evaluate(() => {
    document.querySelector("#game-pin")?.closest("form")?.requestSubmit();
  });
  await page.waitForFunction(() => location.pathname.startsWith("/join/"), { timeout: 25000 });
  check(`join page reached for PIN ${fixture.code}`, path(page) === `/join/${fixture.code}`, path(page));
  await assertNoAuthPrompt(page, "join page: no sign-in prompt");

  await page.waitForSelector("input[placeholder='NICKNAME']", { timeout: 25000 });
  await page.type("input[placeholder='NICKNAME']", nickname);
  // The join form contains avatar/team buttons ahead of the submit control, so
  // submit the form rather than clicking whatever button comes first.
  await page.evaluate(() => {
    document.querySelector("input[placeholder='NICKNAME']")?.closest("form")?.requestSubmit();
  });
  await page.waitForFunction(() => location.pathname.startsWith("/play/"), { timeout: 30000 });
  step(`reached ${path(page)}`);
  return path(page);
}

/** Click the finished-game save affordance and assert we land on the gate. */
async function startSaveFlow(page, markerValue) {
  await waitForText(page, "KEEP YOUR RESULT", 25000);
  await page.evaluate((m) => { window.__bbMarker = m; }, markerValue);
  const beforeUrl = page.url();

  // Capture the RPC round trip: a swallowed error here is the difference
  // between "navigated" and "silently did nothing".
  const rpc = [];
  const onResponse = async (res) => {
    if (!/rpc\/|create_session_claim|rest\/v1/.test(res.url())) return;
    if (!/create_session_claim/.test(res.url())) return;
    let body = "";
    try { body = (await res.text()).slice(0, 400); } catch {}
    rpc.push({ status: res.status(), body });
  };
  page.on("response", onResponse);

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /keep your result|save this result/i.test(b.innerText),
    );
    if (!btn) return "no matching button";
    btn.click();
    return "clicked";
  });
  if (clicked !== "clicked") {
    console.log("   DIAG buttons:", await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
    ));
    throw new Error("save affordance not found on the results screen");
  }

  // Toasts auto-dismiss, so poll rather than reading once at the end.
  const seenToasts = new Set();
  const poll = setInterval(() => {
    void page.evaluate(() =>
      [...document.querySelectorAll("[data-sonner-toast],[role=alert]")]
        .map((n) => n.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)
        .forEach((t) => { window.__bbToasts = window.__bbToasts || []; window.__bbToasts.push(t); }),
    ).catch(() => {});
  }, 250);

  try {
    await page.waitForFunction(() => location.pathname === "/auth", { timeout: 25000 });
  } catch (e) {
    clearInterval(poll);
    page.off("response", onResponse);
    console.log("   DIAG stuck at:", page.url());
    console.log("   DIAG rpc:", JSON.stringify(rpc));
    console.log("   DIAG toasts:", await page.evaluate(() => window.__bbToasts ?? []));
    console.log("   DIAG pending claim:", await page.evaluate(() =>
      window.localStorage.getItem("brainbolt:pending-claim")));
    console.log("   DIAG return intent:", await page.evaluate(() =>
      window.sessionStorage.getItem("brainbolt:return-intent")));
    for (const t of await page.evaluate(() => window.__bbToasts ?? [])) seenToasts.add(t);
    if (seenToasts.size) console.log("   DIAG toast texts:", [...seenToasts]);
    throw e;
  }
  clearInterval(poll);
  page.off("response", onResponse);
  return beforeUrl;
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let activePage = null;

async function dumpFailure(e) {
  console.error(`\nHARNESS ERROR in journey [${currentJourney}]:`, e?.message ?? e);
  if (!activePage) return;
  try {
    console.error("--- url ---\n" + activePage.url());
    console.error("--- page text ---\n" + (await activePage.evaluate(() => document.body.innerText)).slice(0, 1500));
    await activePage.screenshot({ path: join(HERE, "auth-journey-failure.png"), fullPage: true });
    console.error("--- screenshot: scripts/auth-journey-failure.png");
  } catch (inner) {
    console.error("(could not capture page state:", inner?.message, ")");
  }
}

try {
  const cleared = await clearProbeSeats();
  step(`cleared ${cleared} stale probe seat(s)`);

  // ── Journey A: guest plays, then saves the result ────────────────────────────
  currentJourney = "A: guest -> save result -> sign in -> claim";
  {
    await setStatus("lobby");
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    activePage = page;
    await page.setViewport({ width: 1440, height: 900 });

    await joinAsGuest(page, "AuthProbe");
    check("A3: guest reaches the play screen", path(page).startsWith("/play/"), path(page));
    await new Promise((r) => setTimeout(r, 1500));
    await assertNoAuthPrompt(page, "A4: active gameplay");

    await setStatus("ended");
    await page.reload({ waitUntil: "networkidle2" });
    await waitForText(page, "FINAL STANDINGS", 30000);
    check("A5: guest sees the final result", true);
    // The finished-game screen is the ONE place a save affordance belongs.
    await assertNoAuthPrompt(page, "A5: result view", { allowSaveOffer: true });

    const beforeUrl = await startSaveFlow(page, "results-view");
    const authUrl = new URL(page.url());
    check("A6: Save Result opens the sign-in gate", true);
    check(
      "A7: the intended destination is preserved",
      authUrl.searchParams.get("next") === `/play/${fixture.sessionId}`,
      authUrl.searchParams.get("next") || "(missing)",
    );
    // Client-side pushState updates location.pathname BEFORE React re-renders,
    // so waiting on the URL alone can read the previous screen's DOM.
    await waitForText(page, "KEEP YOUR RESULT", 15000);
    check("A8: contextual copy is used", /keep your result/i.test(await body(page)));
    check(
      "A9: no claim token leaked into the URL",
      !/token|claim/i.test(page.url()) && !page.url().includes("#"),
      page.url().slice(0, 120),
    );

    await signIn(page);
    await page.waitForFunction(
      (expected) => location.pathname === expected,
      { timeout: 40000 },
      `/play/${fixture.sessionId}`,
    );
    check("A10: sign-in returns to the same results screen", path(page) === beforeUrl.replace(BASE, ""), path(page));

    const marker = await page.evaluate(() => window.__bbMarker);
    check(
      "A11: the handoff was client-side, not a full reload",
      marker === "results-view",
      marker ? "marker survived" : "window marker lost -> full page reload",
    );

    await waitForText(page, "SAVED TO YOUR COMPETITION HISTORY", 30000);
    check("A12: saved confirmation shown after a real claim", true);

    const intentLeft = await page.evaluate(() => window.sessionStorage.getItem("brainbolt:return-intent"));
    check("A13: the one-shot return intent was consumed", intentLeft === null, intentLeft || "(cleared)");

    const { data: rows } = await admin
      .from("competition_results")
      .select("id,final_score,final_rank")
      .eq("profile_id", account.userId)
      .eq("session_id", fixture.sessionId);
    check("A14: exactly one competition_results row was written", (rows ?? []).length === 1, `${rows?.length} rows`);

    const { data: parts } = await admin
      .from("participants")
      .select("id,profile_id,score")
      .eq("session_id", fixture.sessionId)
      .eq("nickname", "AuthProbe");
    check(
      "A15: the seat is now linked to the signed-in profile",
      (parts ?? []).length === 1 && parts[0].profile_id === account.userId,
      parts?.[0]?.profile_id || "(not linked)",
    );

    const finalText = await body(page);
    check("A16: final standings still rendered", /GG WP/i.test(finalText));
    const claimedScore = rows?.[0]?.final_score ?? null;
    check(
      "A17: the claimed score matches the score on screen",
      claimedScore !== null && finalText.includes(claimedScore.toLocaleString()),
      `claimed=${claimedScore}`,
    );

    await ctx.close();
  }

  // ── Journey B: host flow returns to the host page ────────────────────────────
  currentJourney = "B: unauthenticated -> host -> sign in -> return";
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    activePage = page;
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(`${BASE}/host/${fixture.sessionId}`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => location.pathname === "/auth", { timeout: 30000 });
    const next = new URL(page.url()).searchParams.get("next");
    check("B1: hosting is gated for an unauthenticated user", true);
    check("B2: the host deep-link is the destination", next === `/host/${fixture.sessionId}`, next || "(missing)");
    check("B3: host copy is contextual", /sign in to host a game/i.test(await body(page)));

    await signIn(page);
    await page.waitForFunction(
      (expected) => location.pathname === expected,
      { timeout: 40000 },
      `/host/${fixture.sessionId}`,
    );
    check("B4: sign-in returns to the host control room", path(page) === `/host/${fixture.sessionId}`, path(page));
    // The headline regression: this used to land on /dashboard.
    check("B5: it did NOT land on the dashboard", path(page) !== "/dashboard", path(page));
    await ctx.close();
  }

  // ── Journey C: a typed-in Game PIN survives a voluntary sign-in ──────────────
  currentJourney = "C: landing nav preserves the Game PIN";
  {
    await setStatus("lobby");
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    activePage = page;
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await page.type("#game-pin", fixture.code);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("nav button")].find((b) => /^sign in$/i.test(b.innerText.trim()));
      btn?.click();
    });
    await page.waitForFunction(() => location.pathname === "/auth", { timeout: 25000 });
    const next = new URL(page.url()).searchParams.get("next");
    check("C1: the in-progress Game PIN becomes the destination", next === `/join/${fixture.code}`, next || "(missing)");

    await signIn(page);
    await page.waitForFunction(
      (expected) => location.pathname === expected,
      { timeout: 40000 },
      `/join/${fixture.code}`,
    );
    check("C2: sign-in returns to the join page for that PIN", path(page) === `/join/${fixture.code}`, path(page));
    await assertNoAuthPrompt(page, "C3: join page after sign-in");
    await ctx.close();
  }

  // ── Journey D: sign-out actually ends the session ────────────────────────────
  currentJourney = "D: sign out";
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    activePage = page;
    await page.setViewport({ width: 1440, height: 900 });

    // A guest is gated at the dashboard before anything else.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => location.pathname === "/auth", { timeout: 30000 });
    check("D1: the dashboard is gated for a guest", true);

    // Sign in, and we must land back on the dashboard we asked for.
    await signIn(page);
    await page.waitForFunction(() => location.pathname === "/dashboard", { timeout: 40000 });
    check("D2: sign-in returns to the dashboard", true);

    // Explicit sign-out must end the session.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /^sign out$/i.test(b.innerText.trim()));
      btn?.click();
    });
    await page.waitForFunction(() => location.pathname === "/", { timeout: 30000 });
    check("D3: sign-out returns to the arena", path(page) === "/", path(page));

    // A guest must still be able to play after signing out.
    await page.goto(`${BASE}/join/${fixture.code}`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1500));
    await assertNoAuthPrompt(page, "D4: guest play after sign-out");

    // And the protected surface must be gated again.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => location.pathname === "/auth", { timeout: 30000 });
    check("D5: dashboard is gated again after sign-out", true);

    // Session state must really be gone, not merely hidden.
    const staleSession = await page.evaluate(async () => {
      const raw = Object.keys(window.localStorage).find((k) => k.startsWith("sb-"));
      return raw ? Boolean(window.localStorage.getItem(raw)) : false;
    });
    check("D6: no stale auth session left in storage", staleSession === false, String(staleSession));
    await ctx.close();
  }

  // ── Journey E: mobile repeats the guest save-result journey ──────────────────
  currentJourney = "E: mobile (Pixel 8)";
  {
    await setStatus("lobby");
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    activePage = page;
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    );
    await page.setViewport({ width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    const playPath = await joinAsGuest(page, "MobileProbe");
    check("E3: mobile guest reaches the play screen", playPath.startsWith("/play/"), playPath);
    await new Promise((r) => setTimeout(r, 1500));
    await assertNoAuthPrompt(page, "E4: mobile active gameplay");

    // End the game so the results view (and its save affordance) renders.
    await setStatus("ended");
    await page.reload({ waitUntil: "networkidle2" });
    await waitForText(page, "FINAL STANDINGS", 30000);
    check("E5: mobile guest sees the final result", true);
    await assertNoAuthPrompt(page, "E5: mobile result view", { allowSaveOffer: true });

    await startSaveFlow(page, "mobile-results");
    await signIn(page);
    await page.waitForFunction(
      (expected) => location.pathname === expected,
      { timeout: 40000 },
      `/play/${fixture.sessionId}`,
    );
    const marker = await page.evaluate(() => window.__bbMarker);
    check("E6: mobile handoff was client-side", marker === "mobile-results", marker ? "marker survived" : "full reload");
    await waitForText(page, "SAVED TO YOUR COMPETITION HISTORY", 30000);
    check("E7: mobile saved confirmation", true);
    await ctx.close();
  }

  // ── Journey F: the landing page reflects a signed-in visitor ────────────────
  currentJourney = "F: signed-in landing page";
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    activePage = page;
    await page.setViewport({ width: 1440, height: 900 });

    // Sign in via the landing nav itself, the way a player would.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("nav button")].find((n) => /^sign in$/i.test(n.innerText.trim()));
      b?.click();
    });
    await page.waitForFunction(() => location.pathname === "/auth", { timeout: 25000 });
    check("F1: a guest can start sign-in from the landing nav", true);

    await signIn(page);
    await page.waitForFunction(() => location.pathname === "/", { timeout: 40000 });
    check("F2: sign-in returns to the landing page", path(page) === "/", path(page));

    // The nav must now offer the account surface, not another sign-in.
    const nav = await page.evaluate(() =>
      [...document.querySelectorAll("nav a, nav button")].map((n) => n.innerText.trim()),
    );
    check("F3: the sign-in control is gone for a signed-in visitor", !nav.some((t) => /^sign in$/i.test(t)), JSON.stringify(nav));
    check("F4: the host control is replaced by the dashboard", nav.some((t) => /dashboard/i.test(t)), JSON.stringify(nav));
    check("F5: a profile link is offered", nav.some((t) => /profile/i.test(t)), JSON.stringify(nav));

    // Reload must not regress to the guest nav (session restoration).
    await page.reload({ waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1500));
    const navAfterReload = await page.evaluate(() =>
      [...document.querySelectorAll("nav a, nav button")].map((n) => n.innerText.trim()),
    );
    check(
      "F6: the account nav survives a reload",
      !navAfterReload.some((t) => /^sign in$/i.test(t)) && navAfterReload.some((t) => /dashboard/i.test(t)),
      JSON.stringify(navAfterReload),
    );

    // The join box must still work for a signed-in player.
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 800));
    check("F7: the Game PIN box is still present when signed in", await page.$("#game-pin") !== null);
    await ctx.close();
  }
} catch (e) {
  await dumpFailure(e);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed before the harness stopped`);
  for (const f of failed) console.log(`  FAILED [${f.journey}] ${f.name}`);
  process.exit(1);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAILED [${f.journey}] ${f.name}`);
process.exit(failed.length ? 1 : 0);
