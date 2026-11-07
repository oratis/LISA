import { expect, test } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

const messages = [
  {
    role: "user",
    content: "查看 Google Calendar 今天的忙闲，只输出忙闲区间数量，不输出日程内容。",
  },
  {
    role: "assistant",
    content:
      "今天（2026-11-07，Asia/Shanghai）的忙闲查询完成。\n\n**忙碌区间数量：1**\n\n连接只读流程验收通过 ✅",
  },
  { role: "user", content: "好的，帮我留出一点专注时间。" },
  {
    role: "assistant",
    content: "可以。你希望安排在上午还是下午？\n\n我会先帮你找到合适的空闲时段，再由你确认。",
  },
];

test.describe("mobile app shell", () => {
  // Keep request fixtures authoritative in WebKit, including repeat navigations.
  test.use({
    serviceWorkers: "block",
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  let lisa: LisaInstance;

  test.beforeAll(async () => {
    lisa = await startLisa({ label: "mobile-shell" });
  });
  test.afterAll(async () => {
    await lisa?.stop();
  });
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/history?*", (route) =>
      route.fulfill({ json: { messages, hasMore: false } }),
    );
  });

  test("conversation gets the screen and all composer targets fit small phones", async ({
    page,
  }, info) => {
    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 812 });
      await page.goto(lisa.baseURL);
      await expect(page.locator("#log .msg")).toHaveCount(4);
      await expect(page.locator(".sidebar")).not.toBeVisible();
      await expect(page.locator("#mobileTabs button")).toHaveCount(4);
      await expect(page.locator("#input")).not.toBeFocused();
      const log = await page.locator("#log").boundingBox();
      expect(log!.height).toBeGreaterThan(812 * 0.65);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      for (const id of ["plusBtn", "recordBtn", "sendBtn"]) {
        const button = page.locator("#" + id);
        await expect(button).toBeInViewport();
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      if (width === 375)
        await page.screenshot({ animations: "disabled", path: info.outputPath("phone-dark.png") });
    }
  });

  test("bottom tabs, all navigation entries and sessions remain reachable", async ({
    page,
  }, info) => {
    await page.goto(lisa.baseURL);
    await page.locator('[data-mobile-view="control"]').click();
    await expect(page.locator("#viewControl")).toBeVisible();
    await expect(page.locator('[data-mobile-view="control"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.locator('[data-mobile-view="room"]').click();
    await expect(page.locator("#roomFrame")).toBeVisible();
    await page.locator("#mobileMore").click();
    await expect(page.getByRole("dialog", { name: "Explore Lisa" })).toBeVisible();
    await expect(page.locator("#mobileMenu .nav-item")).toHaveCount(9);
    await expect(page.locator("#sessionTree .tleaf").first()).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: info.outputPath("phone-navigation.png"),
    });
    await page.locator('#navList [data-view="settings"]').click();
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await expect(page.locator("#viewSettings")).toBeVisible();
    await expect(page.locator("#mobileMore")).toHaveAttribute("aria-current", "page");
    await page.locator("#mobileMenuBtn").click();
    const count = await page.locator("#sessionTree .tleaf").count();
    await page.locator("#sbNewSession").click();
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await expect(page.locator("#viewChat")).toBeVisible();
    await expect(page.locator("#sessionTree .tleaf")).toHaveCount(count + 1);
    await expect(page.locator("#input")).not.toBeFocused();
    await page.locator("#mobileNewChat").click();
    await expect(page.locator("#sessionTree .tleaf")).toHaveCount(count + 2);
    await page.locator("#mobileMenuBtn").click();
    await page.locator("#sessionTree .tleaf").last().click();
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await expect(page.locator("#sessionTree .tleaf").last()).toHaveClass(/active/);
  });

  test("a session can be renamed from inside the navigation sheet", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await page.locator("#mobileMenuBtn").click();
    const sheet = page.getByRole("dialog", { name: "Explore Lisa" });
    const row = sheet.locator("#sessionTree .tleaf[data-lisa-id]").first();
    await row.click({ button: "right" });
    // The menu lives inside the open sheet, so the modal does not make it inert.
    const item = sheet.getByRole("menuitem", { name: "Rename session" });
    await expect(item).toBeVisible();
    await item.click();
    await page.getByLabel("Session name", { exact: true }).fill("Phone rename <b>");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".session-rename-dialog")).toHaveCount(0);
    await expect(row.locator(".tname")).toHaveText("Phone rename <b>");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).not.toBeVisible();
    await expect(page.locator(".session-context-menu")).toHaveCount(0);
  });

  test("action sheet, search and theme work without hiding conversation controls", async ({
    page,
  }, info) => {
    await page.goto(lisa.baseURL);
    await page.locator("#mobileToolsBtn").click();
    await page.locator("#fnTheme").click();
    await expect(page.locator("#mobileTools")).not.toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-theme", "calm");
    await page.screenshot({ animations: "disabled", path: info.outputPath("phone-light.png") });
    await page.locator("#fnSearchBtn").click();
    await page.locator("#fnFind").fill("忙碌区间数量");
    await expect(page.locator("#log .msg:visible")).toHaveCount(1);
    await expect(page.locator("#fnFind")).toBeInViewport();
    await page.locator("#fnSearchBtn").click();
    await expect(page.locator("#log .msg:visible")).toHaveCount(4);
    await page.locator("#mobileToolsBtn").click();
    await page.locator("#fnKbSelect").click();
    await expect(page.locator("#log")).toHaveClass(/kb-selecting/);
    await page.locator("#mobileToolsBtn").click();
    await page.locator("#fnMail").click();
    await expect(page.locator("#viewMail")).toBeVisible();
  });

  test("sheets dismiss and desktop restoration preserves a single set of controls", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("lisaCompact", "1"));
    await page.goto(lisa.baseURL);
    await expect(page.locator("#log")).toBeInViewport();
    await page.locator("#mobileMenuBtn").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#mobileMenuBtn")).toBeFocused();
    await expect(page.locator("#mobileMenuBtn")).toHaveAttribute("aria-expanded", "false");
    await page.locator("#mobileMenuBtn").click();
    await page.mouse.click(5, 5);
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await page.locator("#mobileMenuBtn").click();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await expect(page.locator(".frame > .sidebar")).toBeVisible();
    await expect(page.locator("#fnbar #fnTheme")).toBeVisible();
    await expect(page.locator("#fnTheme")).toHaveCount(1);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator("#mobileTabs")).toBeVisible();
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await page.locator("#mobileToolsBtn").click();
    await expect(page.locator("#mobileTools #fnTheme")).toBeVisible();
  });

  test("global keyboard shortcuts hand off focus from native sheets", async ({ page }) => {
    await page.goto(lisa.baseURL);
    await page.locator("#mobileMenuBtn").click();
    await page.keyboard.press("Control+k");
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await expect(page.locator("#switcherInput")).toBeFocused();
    await page.locator("#switcherInput").fill("New session");
    await expect(page.locator("#switcherList .kbd-row").first()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.locator("#mobileToolsBtn").click();
    await page.keyboard.press("?");
    await expect(page.locator("#mobileTools")).not.toBeVisible();
    await expect(page.locator("#modalBg")).toBeVisible();
    await page.locator("#modalClose").click();
    await expect(page.locator("#modalBg")).not.toBeVisible();

    await page.locator("#mobileMenuBtn").click();
    await page.keyboard.press("Meta+f");
    await expect(page.locator("#mobileMenu")).not.toBeVisible();
    await expect(page.locator("#fnFind")).toBeFocused();
    await page.keyboard.press("Escape");

    await page.locator("#mobileToolsBtn").click();
    await page.keyboard.press("Control+/");
    await expect(page.locator("#mobileTools")).not.toBeVisible();
    await expect(page.locator("#input")).toBeFocused();
  });

  test("visual viewport keyboard resize keeps the composer reachable", async ({ page }) => {
    // Browsers in automation do not open an OS keyboard. Exercise the same
    // visualViewport events Safari sends, including restoration after dismissal.
    await page.addInitScript(() => {
      Object.defineProperty(window, "visualViewport", {
        value: Object.assign(new EventTarget(), { height: 812, offsetTop: 0, scale: 1 }),
      });
    });
    await page.route("**/chat", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: 'data: {"type":"text","text":"收到这三行内容。"}\n\ndata: {"type":"done"}\n\n',
      }),
    );
    await page.goto(lisa.baseURL);
    await page.locator("#input").fill("第一行\n第二行\n第三行");
    await page.evaluate(() => {
      Object.assign(window.visualViewport!, { height: 480 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("#mobileTabs")).not.toBeVisible();
    const send = await page.locator("#sendBtn").boundingBox();
    expect(send!.y + send!.height).toBeLessThanOrEqual(480);
    await expect(page.locator("#input")).toHaveValue("第一行\n第二行\n第三行");
    await page.evaluate(() => {
      (document.activeElement as HTMLElement).blur();
      Object.assign(window.visualViewport!, { height: 812 });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("#mobileTabs")).toBeVisible();
    await expect(page.locator("#sendBtn")).toBeInViewport();
    const sent = page.waitForRequest((request) => request.url().endsWith("/chat"));
    await page.locator("#sendBtn").click();
    expect((await sent).postDataJSON().message).toBe("第一行\n第二行\n第三行");
    await expect(page.locator("#log")).toContainText("收到这三行内容。");
    await expect(page.locator("#input")).toHaveValue("");
    await expect(page.locator("#input")).not.toBeFocused();
  });
});
