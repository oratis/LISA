import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

/**
 * First run on a machine with nothing configured. UX-1 calls this the moment
 * that decides whether someone ever gets to meet Lisa, and until now it was
 * only ever verified by hand.
 */
test.describe("first run · API key gate", () => {
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "key-gate", soul: false, apiKey: false, stub: "none" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });

  test("an unconfigured home shows the key gate, not the shell", async ({ page }) => {
    await page.goto(lisa.baseURL);

    const gate = page.locator("#cfgOverlay");
    await expect(gate).toHaveClass(/\bopen\b/);
    await expect(page.locator("#cfgOverlay .cfg-title")).toHaveText(/SET · API · KEY/);
    await expect(page.locator("#cfgAnthropic")).toBeVisible();
    await expect(page.locator("#cfgSave")).toBeVisible();

    // The birth ritual must NOT start before there is a key to birth with.
    await expect(page.locator("#birthOverlay")).not.toHaveClass(/\bopen\b/);
  });

  test("the key field is required and empty submits are refused client-side", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await expect(page.locator("#cfgOverlay")).toHaveClass(/\bopen\b/);

    // required attribute → the browser blocks submit; the request never leaves.
    await expect(page.locator("#cfgAnthropic")).toHaveAttribute("required", "");

    const status = await page.evaluate(async () => {
      const res = await fetch("/api/config/status");
      return (await res.json()) as { configured: boolean };
    });
    expect(status.configured).toBe(false);
  });
});
