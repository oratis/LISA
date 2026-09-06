import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke for the web shell (T-4 / UX-2).
 *
 * Deterministic and offline by construction: every instance runs against a
 * throwaway LISA_HOME and a stub Anthropic server, so the suite never calls a
 * model, never touches ~/.lisa, and costs nothing to run.
 *
 * Chromium only. The shell is not a public website — it is a localhost app the
 * user opens in whatever they already have — so a three-browser matrix buys
 * little and triples the slowest job in CI.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Each spec file owns a server process; running them in parallel would mean
  // N servers plus N builds' worth of memory on a 2-core runner.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    // A first retry that produces no trace is a wasted retry.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
