import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";
import { FIXTURE } from "./helpers/fixture-data.js";

/**
 * The shell a returning user sees: a born soul, a configured key, no overlays.
 * These are the four things that must exist before anything else is worth
 * testing — identity card, 3x3 nav, session tree, composer.
 */
test.describe("main shell", () => {
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "main-shell" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(lisa.baseURL);
    await expect(page.locator("#cfgOverlay")).not.toHaveClass(/\bopen\b/);
    await expect(page.locator("#birthOverlay")).not.toHaveClass(/\bopen\b/);
  });

  test("identity card, 3x3 nav, session tree and composer are all present", async ({ page }) => {
    await expect(page.locator(".sidebar .identity h1")).toHaveText(FIXTURE.name);
    await expect(page.locator("#mascot")).toBeVisible();
    // Born date comes from the fixture seed, so this proves the soul on disk
    // reached the UI rather than a placeholder.
    await expect(page.locator("#identitySub")).toHaveText(/born 2026-01-01 · \d+ days?/);

    // 3x3 view switcher: exactly nine, chat active by default.
    const nav = page.locator("#navList .nav-item");
    await expect(nav).toHaveCount(9);
    await expect(page.locator('#navList .nav-item[data-view="chat"]')).toHaveClass(/\bactive\b/);
    await expect(nav.locator(".nav-label").first()).toHaveText("Chat");

    // Session tree renders its LISA root group.
    await expect(page.locator("#sessionTree .tnode .tlabel").first()).toHaveText("LISA");
    await expect(page.locator("#sbNewSession")).toBeVisible();

    // Composer.
    await expect(page.locator("#form #input")).toBeVisible();
    await expect(page.locator("#form #sendBtn")).toBeVisible();
    await expect(page.locator("#input")).toHaveAttribute("placeholder", /Talk to Lisa/);
  });

  test("nav switches views without a reload", async ({ page }) => {
    await expect(page.locator("#viewChat")).toHaveClass(/\bactive\b/);
    await page.locator('#navList .nav-item[data-view="settings"]').click();
    await expect(page.locator("#viewSettings")).toHaveClass(/\bactive\b/);
    await expect(page.locator("#viewChat")).not.toHaveClass(/\bactive\b/);
    await page.locator('#navList .nav-item[data-view="chat"]').click();
    await expect(page.locator("#viewChat")).toHaveClass(/\bactive\b/);
  });

  test("theme toggle flips the body class and persists lisa-theme", async ({ page }) => {
    const initial = await page.evaluate(() => localStorage.getItem("lisa-theme"));
    expect(initial === null || initial === "nebula").toBeTruthy();

    await page.locator("#fnTheme").click();
    await expect
      .poll(async () => await page.evaluate(() => localStorage.getItem("lisa-theme")))
      .toBe("calm");
    // The theme is an attribute, not a class — body also carries rb-collapsed.
    await expect(page.locator("body")).toHaveAttribute("data-theme", "calm");

    // Survives a reload — the point of persisting it at all.
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-theme", "calm");
    expect(await page.evaluate(() => localStorage.getItem("lisa-theme"))).toBe("calm");

    await page.locator("#fnTheme").click();
    await expect
      .poll(async () => await page.evaluate(() => localStorage.getItem("lisa-theme")))
      .toBe("nebula");
  });

  test("＋ New adds a leaf to the session tree", async ({ page }) => {
    const leaves = page.locator("#sessionTree .tleaf");
    const before = await leaves.count();

    await page.locator("#sbNewSession").click();

    await expect
      .poll(async () => await leaves.count(), { timeout: 15_000 })
      .toBeGreaterThan(before);
    await expect(page.locator("#sessionTree .tleaf.active")).toHaveCount(1);
  });
});
