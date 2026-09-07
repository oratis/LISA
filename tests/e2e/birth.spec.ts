import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

/**
 * The birth ritual, both outcomes, with a stub standing in for Anthropic — so
 * this runs offline and costs nothing.
 *
 * UX-1 is the P0 here: a 401 is retried like a transient failure, the raw
 * provider JSON is rendered at the user, and ENTER just reloads into the same
 * dead end because the key gate never comes back. The assertions describing the
 * fixed behaviour were test.fixme until the UX stream landed it; they are live now and the assertions
 * describing what happens today (the overlay opens, an error surfaces, the soul
 * is NOT written) run now and would catch a regression either way.
 */

test.describe("birth · invalid key (401)", () => {
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "birth-401", soul: false, stub: "unauthorized" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test("the ritual starts and surfaces a failure instead of hanging", async ({ page }) => {
    await page.goto(lisa.baseURL);

    await expect(page.locator("#birthOverlay")).toHaveClass(/\bopen\b/);
    // The SOUL step is where the provider call happens.
    await expect(page.locator("#birthSteps .birth-step .step-name").last()).toBeVisible();

    const err = page.locator("#birthError");
    await expect(err).not.toBeEmpty({ timeout: 30_000 });

    // Nothing was persisted: birth.ts writes seed.json last precisely so a
    // failed dream leaves isBorn() false and the ritual can simply re-run.
    const soul = await page.evaluate(async () => {
      const res = await fetch("/api/soul");
      return (await res.json()) as { born: boolean };
    });
    expect(soul.born).toBe(false);
  });

  test("the stub was actually the only thing contacted", async () => {
    // Guards the whole premise of this suite: if ANTHROPIC_BASE_URL stopped
    // being honoured, these tests would be calling the real API.
    expect(lisa.stub?.requestCount ?? 0).toBeGreaterThan(0);
  });

  test("UX-1 · the error is human, not raw provider JSON", async ({ page }) => {
    await page.goto(lisa.baseURL);
    const err = page.locator("#birthError");
    await expect(err).not.toBeEmpty({ timeout: 30_000 });

    const text = (await err.textContent()) ?? "";
    expect(text).not.toContain('{"type":"error"');
    expect(text).not.toContain("authentication_error");
    expect(text.toLowerCase()).toMatch(/key/);
  });

  test("UX-1 · a Change key button returns to the gate", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await expect(page.locator("#birthError")).not.toBeEmpty({ timeout: 30_000 });

    const changeKey = page.getByRole("button", { name: /change key/i });
    await expect(changeKey).toBeVisible();
    await changeKey.click();

    await expect(page.locator("#cfgOverlay")).toHaveClass(/\bopen\b/);
    await expect(page.locator("#cfgKey")).toBeVisible();
  });
});

test.describe("birth · valid key", () => {
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "birth-ok", soul: false, stub: "ok" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test("the ritual runs to done and ENTER lands in the chat view", async ({ page }) => {
    await page.goto(lisa.baseURL);

    await expect(page.locator("#birthOverlay")).toHaveClass(/\bopen\b/);

    // Every step birth.ts emits, in order, ending at "done".
    const steps = page.locator("#birthSteps .birth-step .step-name");
    await expect
      .poll(async () => await steps.allTextContents(), { timeout: 45_000 })
      .toContain("done");
    expect(await steps.allTextContents()).toEqual(
      expect.arrayContaining(["seed", "soul", "name", "identity", "purpose", "constitution"]),
    );
    await expect(page.locator("#birthError")).toBeEmpty();

    const enter = page.locator("#birthEnter");
    await expect(enter).toBeVisible();
    await enter.click();

    // ENTER reloads; the shell must come up with no overlay in the way.
    await expect(page.locator("#birthOverlay")).not.toHaveClass(/\bopen\b/, { timeout: 30_000 });
    await expect(page.locator("#cfgOverlay")).not.toHaveClass(/\bopen\b/);
    await expect(page.locator("#viewChat")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#form #input")).toBeVisible();
    await expect(page.locator(".sidebar .identity h1")).toHaveText("Lisa");
  });

  test("the soul the stub dreamed is on disk and served back", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const res = await fetch("/api/soul");
            return ((await res.json()) as { born: boolean }).born;
          }),
        { timeout: 45_000 },
      )
      .toBe(true);
  });
});
