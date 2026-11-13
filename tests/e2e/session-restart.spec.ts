import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

test("custom session names survive a process restart and a fresh browser", async ({ browser }) => {
  let lisa: LisaInstance | undefined;
  const first = await browser.newContext();
  const reopened = await browser.newContext();
  try {
    lisa = await startLisa({ label: "session-restart" });
    const page = await first.newPage();
    await page.goto(lisa.baseURL);
    const row = page.locator(".tleaf[data-lisa-id]").first();
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-lisa-id");
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename session" }).click();
    await page.getByLabel("Session name", { exact: true }).fill("重启后保留 · Diary");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row.locator(".tname")).toHaveText("重启后保留 · Diary");
    await first.close();

    await lisa.restart();

    // A new context has no localStorage, cookies or cached page state.
    const fresh = await reopened.newPage();
    await fresh.goto(lisa.baseURL);
    const restored = fresh.locator(`.tleaf[data-lisa-id="${id}"]`);
    await expect(restored.locator(".tname")).toHaveText("重启后保留 · Diary");
    await restored.click();
    await expect(fresh.locator("#tabStrip .ctx-name")).toHaveText("重启后保留 · Diary");
  } finally {
    await first.close();
    await reopened.close();
    await lisa?.stop();
  }
});
