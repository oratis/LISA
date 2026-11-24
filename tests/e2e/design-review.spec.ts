import { expect, test } from "@playwright/test";
import { startLisa } from "./helpers/lisa-server.js";

test("Design Review D-1..D-16 shell layout, empty states, and interactions", async ({ page }) => {
  const lisa = await startLisa({ label: "design-review" });
  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(lisa.baseURL);

    // D-4: short composer placeholder
    await expect(page.locator("#input")).toHaveAttribute("placeholder", "Message Lisa…");

    // D-15: function bar has 3 separators splitting 4 functional groups
    await expect(page.locator("#fnbar .fbar-sep")).toHaveCount(3);

    // D-5 & D-4: right rail toggle highlights ONLY when panel is open; at 1200px rightbar overlays as drawer
    const fnPanel = page.locator("#fnPanel");
    await expect(fnPanel).not.toHaveClass(/\bactive\b/);
    await fnPanel.click();
    await expect(fnPanel).toHaveClass(/\bactive\b/);
    const rightbarBox = await page.locator(".rightbar").boundingBox();
    const logBox = await page.locator("#log").boundingBox();
    expect(rightbarBox && rightbarBox.width).toBeGreaterThan(280);
    expect(logBox && logBox.width).toBeGreaterThan(700);

    // D-1: session list gets generous vertical room at 1200×800 and short-window hides nav labels
    const treeHeightDesktop = await page.locator("#sessionTree").evaluate((el) => el.clientHeight);
    expect(treeHeightDesktop).toBeGreaterThanOrEqual(240);
    await page.setViewportSize({ width: 760, height: 640 });
    await expect(page.locator(".nav-item .nav-label").first()).toBeHidden();
    const treeHeightShort = await page.locator("#sessionTree").evaluate((el) => el.clientHeight);
    expect(treeHeightShort).toBeGreaterThanOrEqual(150);

    await page.setViewportSize({ width: 1200, height: 800 });

    // D-16: find in chat opens cleanly
    await page.evaluate(() =>
      (window as unknown as { lisaOpenFind?: () => void }).lisaOpenFind?.(),
    );
    await expect(page.locator("#fnFind")).toBeVisible();
    await page.keyboard.press("Escape");

    // D-11: Soft Ink sticker empty states across Control, Mail, Knowledge (and hidden sweep when empty)
    await page.locator('[data-view="control"]').click();
    await expect(page.locator("#viewControl .lisa-empty-state img")).toBeVisible();

    await page.locator('[data-view="kb"]').click();
    await expect(page.locator("#viewKb .lisa-empty-state img")).toBeVisible();
    await expect(page.locator("#kbList")).toHaveClass(/\bis-empty\b/);

    // D-7: Settings expressions use two labelled rows under an outside section label
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator("#viewSettings #expressionDisplay")).toBeVisible();
    await expect(page.locator("#viewSettings #expressionFrequency")).toBeVisible();

    // Mail view is reached via hash navigation and hides header actions when no mailbox is connected
    await page.goto(lisa.baseURL + "/#mail");
    await expect(page.locator("#viewMail .lisa-empty-state img")).toBeVisible();
    await expect(page.locator("#mailSweepBtn")).toBeHidden();
    await expect(page.locator("#mailConnectBtn")).toBeHidden();
  } finally {
    await lisa.stop();
  }
});
