import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test.describe("Improve LISA M0/M1", () => {
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "improve-lisa" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test("fixed sidebar entry preserves 3x3 nav and supports create -> preview -> apply -> rollback -> export", async ({
    page,
  }) => {
    await page.goto(lisa.baseURL);
    await expect(page.locator("#cfgOverlay")).not.toHaveClass(/\bopen\b/);

    // 3x3 primary nav stays strictly 9 items; Improve LISA sits outside #navList.
    await expect(page.locator("#navList .nav-item")).toHaveCount(9);
    const improveBtn = page.locator("#sbImproveBtn");
    await expect(improveBtn).toBeVisible();

    await improveBtn.click();
    await expect(page.locator("#viewImprove")).toHaveClass(/\bactive\b/);
    await expect(improveBtn).toHaveClass(/\bactive\b/);

    // Create draft
    await page.locator("#impTitle").fill("Weekly release digest");
    await page.locator("#impGoal").fill("Summarize weekly PRs and open blockers in bullet form.");
    await page
      .locator("#impContent")
      .fill(
        "---\nname: weekly-release-digest\ndescription: Summarize weekly PRs cleanly\n---\n\n# Weekly Release Digest\n\nList highlights and blockers.\n",
      );
    await page.locator('#improveCreateForm button[type="submit"]').click();

    const card = page.locator("[data-imp-card]").first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("Weekly release digest");

    // Preview & check
    await card.locator('[data-imp-act="preview"]').click();
    await expect(card).toContainText("work: preview_ready");
    await expect(card.locator('[data-imp-act="apply"]')).toBeVisible();

    // Apply to my LISA
    await card.locator('[data-imp-act="apply"]').click();
    await expect(card).toContainText("apply: active");
    await expect(card.locator('[data-imp-act="rollback"]')).toBeVisible();

    // Active capability appears in "My capabilities" tab
    await page.locator('[data-imp-tab="capabilities"]').click();
    await expect(page.locator("#viewImprove")).toContainText("weekly-release-digest");

    // Rollback preserves history and clears active status
    await page.locator('[data-imp-tab="history"]').click();
    await card.locator('[data-imp-act="rollback"]').click();
    await expect(card).toContainText("apply: rolled_back");

    // Prepare de-privatized community PR export
    await card.locator('[data-imp-act="export"]').click();
    await expect(card.locator(".improve-contrib")).toBeVisible();
    await expect(card.locator('.improve-contrib a[href^="https://github.com/"]')).toBeVisible();
  });
});
