import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

let lisa: LisaInstance;
test.use({ locale: "en-US", serviceWorkers: "block" });
test.beforeAll(async () => {
  lisa = await startLisa({ label: "public-games" });
});
test.afterAll(async () => {
  await lisa?.stop();
});

test("the owner searches, selects an edition, and changes price region without any chat or account data", async ({
  page,
}) => {
  const bodies: unknown[] = [];
  const mainId = "018d937f-012f-73b8-ab2c-898516969e6a",
    deluxeId = "018d937f-07fc-72ed-8517-d8e24cb1eb22";
  await page.route("**/api/games/public", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { igdb: false, itad: true } });
      return;
    }
    const body = route.request().postDataJSON();
    bodies.push(body);
    if (body.action === "search") {
      await route.fulfill({
        json: {
          provider: "itad",
          games: [
            { id: mainId, title: "Sample Game", type: "game", slug: "sample-game" },
            { id: deluxeId, title: "Sample Deluxe", type: "package", slug: "sample-deluxe" },
          ],
        },
      });
      return;
    }
    if (body.action === "history") {
      await route.fulfill({
        json: { id: deluxeId, country: body.country, history: [], truncated: false },
      });
      return;
    }
    const price = { amount: 39, currency: body.country === "US" ? "USD" : "CNY" };
    await route.fulfill({
      json: {
        provider: "itad",
        id: deluxeId,
        country: body.country,
        offers: [
          {
            shop: "Sample Shop",
            price,
            regular: price,
            updatedAt: "2026-11-20T00:00:00Z",
            platforms: ["PC"],
            url: "https://isthereanydeal.com/link/fixture/?aff=keep",
          },
        ],
        historicalLow: price,
        retrievedAt: "2026-11-21T00:00:00Z",
      },
    });
  });
  await page.goto(lisa.baseURL + "/#dashboard");
  await page.locator(".dc-game-lookup").click();
  const panel = page.locator("#modalBody");
  await expect(panel.getByLabel("Source")).toHaveValue("itad");
  await panel.getByLabel("Game title or Steam App ID").fill("Sample");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const choose = panel.getByRole("button", { name: "Sample Deluxe" });
  await choose.click();
  await expect(panel.getByLabel("Price region")).toBeFocused();
  expect(bodies).toEqual([{ provider: "itad", action: "search", title: "Sample" }]);
  await panel.getByLabel("Price region").fill("CN");
  await choose.click();
  await expect(panel.getByRole("link", { name: "Sample Shop · 39 CNY" })).toHaveAttribute(
    "href",
    "https://isthereanydeal.com/link/fixture/?aff=keep",
  );
  await expect(
    panel.getByText("Current low across covered stores · 39 CNY · Sample Shop"),
  ).toBeVisible();
  await expect(panel.getByText("Historical low across covered stores · 39 CNY")).toBeVisible();
  await panel.getByRole("button", { name: "Show recent price changes" }).click();
  await expect(panel.getByText("No changes recorded.")).toBeVisible();
  await panel.getByLabel("Price region").fill("US");
  await choose.click();
  await expect(panel.getByRole("link", { name: "Sample Shop · 39 USD" })).toBeVisible();
  expect(bodies).toEqual([
    { provider: "itad", action: "search", title: "Sample" },
    { provider: "itad", action: "details", id: deluxeId, country: "CN" },
    { provider: "itad", action: "history", id: deluxeId, country: "CN" },
    { provider: "itad", action: "details", id: deluxeId, country: "US" },
  ]);
  expect(lisa.stub!.requestCount).toBe(0);
  await panel.getByLabel("Source").selectOption("igdb");
  await expect(panel.getByLabel("Price region")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await expect(panel.getByText(/Set LISA_IGDB_CLIENT_ID/)).toBeVisible();
});

test("input stays editable during delayed configuration and the panel can retry a failed configuration load", async ({
  page,
}) => {
  let calls = 0;
  let started!: () => void;
  const deferred = new Promise<void>((resolve) => {
    started = resolve;
  });
  let ready!: () => void;
  const finish = new Promise<void>((resolve) => {
    ready = resolve;
  });
  await page.route("**/api/games/public", async (route) => {
    if (++calls === 1) {
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
      return;
    }
    started();
    await finish;
    await route.fulfill({ json: { igdb: true, itad: true } });
  });
  await page.goto(lisa.baseURL + "/#dashboard");
  await page.locator(".dc-game-lookup").click();
  const panel = page.locator("#modalBody");
  await panel.getByRole("button", { name: "Retry loading sources" }).click();
  await deferred;
  await panel.getByLabel("Game title or Steam App ID").fill("Test");
  await panel.getByLabel("Source").selectOption("itad");
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  ready();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await expect(panel.getByLabel("Source")).toHaveValue("itad");
  await expect(panel.getByLabel("Game title or Steam App ID")).toHaveValue("Test");
});
