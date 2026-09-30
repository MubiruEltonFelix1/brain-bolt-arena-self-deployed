import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end verification of the guest result-claim journey.
 *
 * This is a REAL test against a REAL app talking to the configured Supabase
 * project. It is not a mock and it is not a component test: the point of
 * Phase 9F was that the journey had never actually been exercised, and only a
 * real run can say whether it works.
 *
 * WHAT IT WRITES
 * `e2e/seed.ts` creates a scratch quiz, session, participants and answers
 * through the service role, and deletes them afterwards. Every row it creates
 * is tagged `e2e` so a leaked fixture is obvious in any table you open.
 * Nothing it creates is ever joined to a real account, and the auth account it
 * creates is named `e2e+...@example.invalid` so it is unmistakable.
 *
 * It does not touch the launch quiz or any pre-existing session.
 */
/**
 * The dev server binds 8080 by default and silently moves to 8081 when that
 * port is taken, which would leave the tests pointed at a dead URL. The E2E
 * run therefore gets its own pinned port with --strictPort, so a port clash
 * fails loudly here instead of as a pile of confusing connection errors.
 */
const E2E_PORT = process.env.E2E_PORT ?? "5199";
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // `.e2e.ts` rather than the default `*.spec.ts`: `bun test` collects anything
  // matching `*.spec.*` / `*.test.*` and would try to run these with
  // `bun:test`, which exports neither Playwright's `test` nor its `expect`.
  // This suffix is invisible to bun and explicit here.
  testMatch: /.*\.e2e\.ts$/,
  // Claiming touches a live database; parallel workers would interleave.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // The claim state is the thing under test; a generous action timeout is
    // worth more than a pretty trace here.
    actionTimeout: 20_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `bun run dev --port ${E2E_PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
