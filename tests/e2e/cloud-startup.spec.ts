import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test.describe("hosted startup", () => {
  let lisa: LisaInstance;
  test.beforeAll(async () => {
    lisa = await startLisa({ label: "cloud-startup", stub: "expressions" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test("cloud chat never asks for operator keys and keeps expression settings usable", async ({
    page,
  }) => {
    await page.route("**/api/edition", (route) =>
      route.fulfill({
        json: { edition: "cloud", macOnlyDisabled: [] },
      }),
    );
    let configReads = 0;
    await page.route("**/api/config/status", (route) => {
      configReads++;
      return route.fulfill({
        status: 403,
        json: { error: "capability_denied", profile: "cloud-chat" },
      });
    });
    await page.goto(lisa.baseURL);
    await page.locator("#input").fill("send an animated sticker");
    await page.locator("#sendBtn").click();
    await expect(page.locator(".expression-bubble")).toHaveCount(1);
    await expect(page.locator("#cfgOverlay")).not.toHaveClass(/open/);
    await page.locator('[data-view="settings"]').click();
    await expect(page.locator("#expressionDisplay")).toBeEnabled();
    await page.locator("#expressionDisplay").selectOption("static");
    await expect(page.locator(".expression-settings [role=status]")).toHaveText(/Saved|已保存/);
    await expect(page.locator("#setKey")).toHaveCount(0);
    expect(configReads).toBe(0);
  });
});
