import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";
let lisa: LisaInstance;
test.use({ locale: "zh-CN", serviceWorkers: "block" });
test.beforeAll(async () => {
  lisa = await startLisa({ label: "companion-refresh" });
});
test.afterAll(async () => {
  await lisa?.stop();
});
test("dashboard lists every connector with truthful status and keeps setup drafts editable", async ({
  page,
  request,
}) => {
  const catalog = await (await request.get(lisa.baseURL + "/api/connectors")).json();
  expect(catalog.connectors).toHaveLength(22);
  expect(catalog.connectors.find((a: { id: string }) => a.id === "box").connection.status).toBe(
    "unavailable",
  );
  expect(
    catalog.connectors.find((a: { id: string }) => a.id === "obsidian").connection.status,
  ).toBe("disconnected");
  await page.goto(lisa.baseURL + "/#dashboard");
  await expect(page.locator(".dc-card")).toHaveCount(22);
  await page.getByRole("button", { name: "应用连接器", exact: true }).click();
  await expect(page.locator("#dashboardConnectors")).toBeFocused();
  const missingMarks = await page.locator(".dc-card").evaluateAll((cards) =>
    cards
      .filter((card) => {
        const use = card.querySelector<SVGUseElement>(".connector-mark use");
        return (
          use?.getAttribute("href") !== "#product-" + card.getAttribute("data-provider") ||
          !use.getBBox().width
        );
      })
      .map((card) => card.getAttribute("data-provider")),
  );
  expect(missingMarks).toEqual([]);
  await page.locator(".dc-toolbar input").fill("Box");
  await expect(page.locator(".dc-card")).toHaveCount(2); // Box and Dropbox
  await expect(page.locator('.dc-card[data-provider="box"]')).toContainText("待配置");
  await page.locator(".dc-toolbar input").fill("Obsidian");
  await expect(page.locator(".dc-card")).toHaveCount(1);
  await page.locator(".dc-card button").click();
  await expect(page.locator("#input")).toHaveValue(
    "检索我选定的 Obsidian 保险库并总结 Markdown 笔记。",
  );
  expect(lisa.stub!.requestCount).toBe(0);
  await page.locator("#sendBtn").click();
  await expect(page.getByRole("region", { name: "Obsidian 只读连接" })).toContainText(
    "选择本机保险库",
  );
  await page.getByRole("button", { name: "选择本机保险库", exact: true }).click();
  await expect(page.getByRole("region", { name: "Obsidian 只读连接" })).toContainText(
    "请先在本机 Obsidian 中打开一个保险库",
  );
});
test("room, Rêve, Control and sticker picker fit desktop and narrow center panes", async ({
  page,
}) => {
  const dir = path.resolve(".tmp/companion-refresh/screens");
  await fs.mkdir(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/events", () => {});
  await page.route("**/api/island/ping", (route) =>
    route.fulfill({ json: { online: true, mood: "working-coding" } }),
  );
  await page.goto(lisa.baseURL + "/#room");
  const room = page.frameLocator("#roomFrame");
  await expect(room.locator("#lisa-motion")).toBeVisible();
  await expect(room.locator("#lisa-motion")).toHaveAttribute(
    "data-motion-clip",
    "room-work-natural",
  );
  await expect(room.locator("#lisa-wrap")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: path.join(dir, "room-desktop.png") });
  for (const view of ["reve", "control", "dashboard"]) {
    await page.locator('.nav-item[data-view="' + view + '"]').click();
    if (view === "reve") await expect(page.locator(".rv-grid > .rv-card")).toHaveCount(6);
    if (view === "dashboard") await expect(page.locator(".dc-card")).toHaveCount(22);
    await page.screenshot({ path: path.join(dir, view + "-desktop.png") });
  }
  await page.goto(lisa.baseURL + "/#control/remote");
  const fleet = page.frameLocator("#controlFleet");
  await expect(fleet.locator(".steps")).toBeVisible();
  await page.screenshot({ path: path.join(dir, "remote-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(lisa.baseURL + "/#chat");
  await page.locator("#expressionPickerBtn").click();
  await expect(page.locator(".expression-grid button")).toHaveCount(12);
  await expect
    .poll(() =>
      page
        .locator(".expression-grid img")
        .first()
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: path.join(dir, "stickers-mobile.png") });
  expect(
    await page.locator(".expression-picker").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBeTruthy();
  await page.keyboard.press("Escape");
  for (const view of ["reve", "control", "dashboard"]) {
    await page.goto(lisa.baseURL + "/#" + view);
    if (view === "reve") await expect(page.locator(".rv-grid > .rv-card")).toHaveCount(6);
    if (view === "dashboard") await expect(page.locator(".dc-card")).toHaveCount(22);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.screenshot({ path: path.join(dir, view + "-mobile.png") });
  }
});

test("all new seated activities stay anchored in both rooms", async ({ page }) => {
  const dir = path.resolve(".tmp/companion-refresh/screens");
  await fs.mkdir(dir, { recursive: true });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.route("**/events", () => {});
  let mood = "working-coding";
  await page.route("**/api/island/ping", (route) =>
    route.fulfill({ json: { online: true, mood } }),
  );
  for (const theme of ["room", "room2"]) {
    await page.addInitScript((theme) => localStorage.setItem("lisa-room-theme", theme), theme);
    for (const [activity, pose] of [
      ["working-coding", "work"],
      ["reading-book", "read"],
      ["drinking-tea", "tea"],
    ]) {
      mood = activity!;
      await page.goto(lisa.baseURL + "/room");
      await expect(page.locator("#lisa-wrap")).toHaveAttribute("data-pose", pose!);
      await expect(page.locator("#lisa-wrap")).toHaveCSS("opacity", "1");
      await expect(page.locator("#lisa-motion")).toHaveAttribute(
        "data-motion-clip",
        "room-" + pose + "-natural",
      );
      await expect(page.locator("#lisa")).toHaveClass(/motion-ready/);
      await page.screenshot({ path: path.join(dir, theme + "-" + pose + ".png") });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.locator("#lisa-motion")).toHaveAttribute("data-motion-state", "static");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  }
});
