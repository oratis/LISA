import { expect, test, type Page } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

let lisa: LisaInstance;
test.beforeAll(async () => {
  lisa = await startLisa({ label: "control-fleet", stub: "none" });
});
test.afterAll(async () => {
  await lisa?.stop();
});

async function devices(page: Page) {
  const state = { started: 0, followups: 0, status: "completed", control: true, empty: false };
  await page.route("**/api/fleet/hosts", (route) =>
    route.fulfill({
      json: {
        scope: "test-account",
        hosts: state.empty
          ? []
          : [
              { id: "mac-a", name: "Studio Mac", online: true, paired: true },
              { id: "mac-b", name: "MacBook Air", online: false, paired: true },
            ],
      },
    }),
  );
  await page.route("**/api/fleet/request", (route) => {
    const { path, method, payload } = route.request().postDataJSON();
    if (path === "/capabilities")
      return route.fulfill({
        json: {
          workspaces: [{ id: "project", name: "LISA" }],
          control: state.control,
          agents: [{ id: "claude-code", start: true }],
          features: ["session-capabilities"],
        },
      });
    if (path === "/runs" && method === "POST") {
      expect(payload.workspaceId).toBe("project");
      expect(payload.hostId).toBe("mac-a");
      expect(payload.text).toBe("Build the settings page");
      state.started++;
      state.status = "waiting";
      return route.fulfill({ json: { status: "accepted", run: { id: "task-1" } } });
    }
    if (path === "/runs/task-1/messages") {
      expect(payload.text).toBe("Add keyboard navigation");
      state.followups++;
      return route.fulfill({ json: { status: "accepted", run: { id: "task-1" } } });
    }
    if (path === "/runs")
      return route.fulfill({
        json: {
          runs: [
            {
              id: "task-1",
              workspaceId: "project",
              agent: "claude-code",
              state: state.status,
              createdAt: "2026-11-16T02:00:00Z",
              updatedAt: "2026-11-16T02:05:00Z",
              result: "Settings page is ready for review. <script>not executable</script>",
              capabilities: { append: state.control && state.status === "waiting" },
            },
          ],
        },
      });
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return state;
}

for (const locale of ["en-US", "zh-CN"]) {
  test.describe(locale, () => {
    test.use({ locale });
    test("remote tasks stay inside Control, retain drafts, follow theme and use one locale", async ({
      page,
    }) => {
      const state = await devices(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(lisa.baseURL + "/#control");
      await expect(page.locator("#navList .nav-item")).toHaveCount(9);
      await expect(page.locator('.sidebar a[href="/fleet"]')).toHaveCount(0);
      await expect(page.locator("#controlFleet")).toHaveCount(0);
      await page
        .getByRole("tab", { name: locale === "zh-CN" ? "远程 Mac" : "Remote Macs" })
        .click();
      await expect(page).toHaveURL(/#control\/remote$/);
      const fleet = page.frameLocator("#controlFleet");
      await fleet.getByRole("button", { name: /Studio Mac/ }).click();
      await expect(fleet.locator("#work")).toBeVisible();
      await expect(fleet.locator("#start")).toBeDisabled();
      await expect(fleet.locator(".standalone-header")).toBeHidden();
      await expect(fleet.locator("#runs pre")).toContainText("<script>not executable</script>");
      await expect(fleet.locator("#runs script")).toHaveCount(0);
      const copy = await fleet.locator("main").innerText();
      if (locale === "en-US") expect(copy).not.toMatch(/[\u3400-\u9fff]/);
      else {
        await expect(page.locator(".control-head h2")).toHaveText("控制中心");
        await expect(fleet.locator("#start")).toHaveText("启动任务");
        expect(copy).not.toMatch(/Remote Macs|Workspace|Start task|Capabilities/);
      }
      await fleet.locator("#prompt").fill("Build the settings page");
      await fleet.locator("#refresh").click();
      await expect(fleet.locator("#prompt")).toHaveValue("Build the settings page");
      await page.locator("#ctrlLocalTab").click();
      await expect(page.locator("#ctrlScroll")).toBeVisible();
      await page.locator("#ctrlRemoteTab").click();
      await expect(fleet.locator("#prompt")).toHaveValue("Build the settings page");
      await page.evaluate(() => {
        localStorage.setItem("lisa-theme", "nebula");
      });
      await expect(fleet.locator("html")).toHaveAttribute("data-theme", "nebula");
      await fleet.locator("#start").click();
      await expect.poll(() => state.started).toBe(1);
      await expect(fleet.locator("#follow")).toBeVisible();
      await expect(fleet.locator("#start")).toBeHidden();
      await expect(fleet.locator("#follow")).toBeDisabled();
      await fleet.locator("#prompt").fill("Add keyboard navigation");
      await fleet.locator("#follow").click();
      await expect.poll(() => state.followups).toBe(1);
      expect(errors).toEqual([]);
    });
  });
}

test.describe("Chinese layouts", () => {
  test.use({ locale: "zh-CN" });
  test("deep links, keyboard tabs, empty setup and mobile layout", async ({ page }) => {
    const state = await devices(page);
    state.empty = true;
    await page.goto(lisa.baseURL + "/#control/remote");
    const fleet = page.frameLocator("#controlFleet");
    await expect(fleet.getByRole("heading", { name: "连接你的第一台 Mac" })).toBeVisible();
    await page.locator("#ctrlRemoteTab").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#ctrlLocalTab")).toBeFocused();
    await expect(page.locator("#ctrlScroll")).toBeVisible();
    await page.keyboard.press("End");
    await expect(page.locator("#ctrlRemoteTab")).toBeFocused();
    await expect(page.locator("#ctrlRemote")).toBeVisible();
    state.empty = false;
    await fleet.locator("#refresh").click();
    await fleet.getByRole("button", { name: /Studio Mac/ }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.screenshot({ path: "test-results/control-remote-desktop.png" });
    await page.locator("#ctrlLocalTab").click();
    await page.screenshot({ path: "test-results/control-local-desktop.png" });
    await page.locator("#ctrlRemoteTab").click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/control-remote-dark.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    const frame = page.frames().find((item) => item.url().includes("/fleet"))!;
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(fleet.locator("#prompt")).toBeVisible();
    await page.screenshot({ path: "test-results/control-remote-mobile.png" });
  });
  test("read-only and offline states give a next step without enabling a task", async ({
    page,
  }) => {
    const state = await devices(page);
    state.control = false;
    await page.goto(lisa.baseURL + "/#control/remote");
    const fleet = page.frameLocator("#controlFleet");
    await fleet.getByRole("button", { name: /Studio Mac/ }).click();
    await fleet.locator("#prompt").fill("A draft");
    await expect(fleet.locator("#start")).toBeDisabled();
    await expect(fleet.locator("#start-hint")).toContainText("查看权限");
    await fleet.getByRole("button", { name: /MacBook Air/ }).click();
    await expect(fleet.locator("#connection-action")).toContainText("离线");
    await expect(fleet.locator("#work")).toBeHidden();
    await expect(fleet.locator("#runs")).toBeEmpty();
  });
  test("setup catches up with relay and pairing changes without losing grant choices", async ({
    page,
  }) => {
    const state = await devices(page);
    state.empty = true;
    const link = {
      enabled: false,
      signedIn: false,
      online: false,
      error: "",
      devices: [],
      pending: [] as { id: string; code: string; fleet: boolean; waiting: boolean }[],
    };
    let reads = 0;
    let finishInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      finishInitialRead = resolve;
    });
    await page.route("**/api/fleet/local", async (route) => {
      reads++;
      if (reads === 1) await initialRead;
      return route.fulfill({
        json: { link, workspaces: [{ id: "project", name: "Test project" }], runs: [] },
      });
    });
    await page.route("**/api/remote/connect", (route) => {
      link.enabled = link.signedIn = true;
      return route.fulfill({ json: link });
    });
    await page.clock.install();
    await page.goto(lisa.baseURL + "/#control/remote");
    const fleet = page.frameLocator("#controlFleet");
    await fleet.locator("#setup").click();
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(8000);
    expect(reads).toBe(1);
    finishInitialRead();
    await expect(fleet.locator("#local-workspaces")).toContainText("Test project");
    await fleet.locator("#connect").click();
    await expect(fleet.locator("#link-status")).toHaveText("正在连接账号中继…");
    link.online = true;
    await page.clock.runFor(4000);
    await expect(fleet.locator("#link-status")).toHaveText("已连接账号中继");
    await expect(fleet.locator("#connect")).toBeHidden();
    link.pending.push({ id: "first", code: "111111", fleet: true, waiting: false });
    await page.clock.runFor(4000);
    const first = fleet.locator("#requests article").filter({ hasText: "111111" });
    await first.getByLabel("Test project", { exact: true }).check();
    await first.getByLabel("允许在选定目录启动和控制 Claude Code").check();
    await fleet.locator("#alias").fill("Unsubmitted workspace");
    link.pending.push({ id: "second", code: "222222", fleet: true, waiting: false });
    await page.clock.runFor(4000);
    await expect(fleet.locator("#requests article")).toHaveCount(2);
    await expect(first.getByLabel("Test project", { exact: true })).toBeChecked();
    await expect(first.getByLabel("允许在选定目录启动和控制 Claude Code")).toBeChecked();
    await expect(
      fleet
        .locator("#requests article")
        .filter({ hasText: "222222" })
        .getByLabel("Test project", { exact: true }),
    ).not.toBeChecked();
    await expect(fleet.locator("#alias")).toHaveValue("Unsubmitted workspace");
    await fleet.locator("body").evaluate(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.type === "lisa-fleet-visibility")
          document.body.dataset.testVisible = String(event.data.visible);
      });
    });
    await page.locator("#ctrlLocalTab").click();
    await expect(fleet.locator("body")).toHaveAttribute("data-test-visible", "false");
    const hiddenReads = reads;
    await page.clock.runFor(8000);
    expect(reads).toBe(hiddenReads);
  });
});
