import { appendMemory } from "../../src/memory/store.js";
import { homeScope } from "../../src/paths.js";
import { withDream } from "../../src/reve/record.js";
import { writeIdentity } from "../../src/soul/store.js";
import { test, expect } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";
import { seedReve } from "./helpers/reve-data.js";

test.describe("Rêve memory and reflection", () => {
  let lisa: LisaInstance;
  test.beforeAll(async () => {
    lisa = await startLisa({ label: "reve" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });
  test("empty state, persisted evidence, restore and mobile layout", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await page.locator('#navList [data-view="reve"]').click();
    await expect(page.locator("#reveContent")).toContainText("No memory changes");
    await expect(page.locator("#reveReflect")).toBeDisabled();
    const id = await seedReve(lisa.home);
    await page.locator("#reveRefresh").click();
    await expect(page.locator(".rv-revision")).toHaveCount(1);
    await expect(page.locator(".rv-usage")).toContainText("1,853");
    const change = page.locator(`[data-revision="${id}"]`);
    await change.locator("summary").click();
    await expect(change.locator(".rv-diff")).toContainText("3000");
    await expect(change.locator(".rv-diff")).toContainText("5757");
    await expect(change.locator("blockquote")).toContainText("Keep the Sunday backup schedule");
    await change.locator("[data-session]").click();
    await expect(page.locator("#viewChat")).toHaveClass(/active/);
    await expect(page.locator("#log")).toContainText("Keep the Sunday backup schedule");
    await page.locator('#navList [data-view="reve"]').click();
    await change.locator("summary").click();
    await expect(change.locator(".rv-restore")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".rv-restore")).toBeVisible();
    expect(
      await page.locator("#reveContent").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBeTruthy();
    await page.locator(".rv-restore").click();
    await expect(page.locator("#reveStatus")).toContainText("Previous memory restored");
    const memory = await page.request.get(lisa.baseURL + "/api/reve/revisions/" + id);
    expect((await memory.json()).canRestore).toBe(false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.locator('#navList [data-view="reve"]').click();
    await expect(page.locator(".rv-revision")).toHaveCount(2);
  });
  test("dream log keeps selective undo, reconsideration and the local agent recap accessible", async ({
    page,
  }) => {
    await homeScope.run(lisa.home, () =>
      withDream({ trigger: "idle" }, async () => {
        await appendMemory("memory", "Atlas maintenance takes place on Monday.");
        await writeIdentity("I am Lisa; I keep the project maintenance schedule.");
      }),
    );
    await page.goto(lisa.baseURL + "/#reve");
    const log = page.locator("[data-dream-log]");
    await log.locator(":scope > summary").click();
    const dream = log.locator("[data-dream]").first();
    await dream.locator(":scope > summary").click();
    await dream
      .locator(".rv-reconsider textarea")
      .fill("Please reconsider the maintenance detail.");
    await dream.getByRole("button", { name: "Send note" }).click();
    await expect(page.locator("#reveStatus")).toContainText("next reflection");
    await log.locator(":scope > summary").click();
    await dream.locator(":scope > summary").click();
    await expect(dream).toContainText("Please reconsider the maintenance detail.");
    await dream.getByRole("button", { name: "Undo memory changes" }).click();
    await expect(page.locator("#reveStatus")).toContainText("reverted");
    const recap = page.locator("[data-agent-recap]");
    await recap.locator(":scope > summary").click();
    await expect(recap.locator(".rv-recap")).not.toHaveText("Loading…");
  });
  test("failed period load can retry and reference content is escaped", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await page.locator('#navList [data-view="reve"]').click();
    await expect(page.locator(".rv-stats")).toBeVisible();
    await page.route("**/api/reve?days=1", (route) =>
      route.fulfill({ status: 503, json: { error: "reve_unavailable" } }),
    );
    await page.locator("#reveWindow").selectOption("1");
    await expect(page.locator("#reveStatus")).toContainText("Could not load");
    await expect(page.locator(".rv-stats")).toHaveCount(0);
    await page.unroute("**/api/reve?days=1");
    await page.route("**/api/reve?days=1", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.reflections = [
        {
          at: new Date().toISOString(),
          sessionId: "s1",
          summary: '<img src=x onerror="window.injected=true">',
          appliedCount: 0,
          skipped: [],
        },
      ];
      await route.fulfill({ json: data });
    });
    await page.locator("#reveRefresh").click();
    await expect(page.locator(".rv-reflection")).toContainText("<img src=x");
    await expect(page.locator(".rv-reflection img")).toHaveCount(0);
  });
});
