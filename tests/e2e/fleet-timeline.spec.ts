import { expect, test, type Page } from "@playwright/test";
import { startLisa, type LisaInstance } from "./helpers/lisa-server.js";

const macA = { id: "a".repeat(32), name: "Mac A", online: true, paired: true };
const macB = { ...macA, id: "b".repeat(32), name: "Mac B" };
const workspaceId = "ac290f4b-3c7a-41b1-8e0c-872c73393fda";
const runId = "cf9f90c7-6a93-4652-a2fa-e71c8f1a8561";
let lisa: LisaInstance;

test.beforeAll(async () => {
  lisa = await startLisa({ label: "fleet-timeline", stub: "none" });
});
test.afterAll(async () => {
  await lisa?.stop();
});

async function openTask(page: Page) {
  const state = { lastSeq: 2, revoked: false, macBUnavailable: true };
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await page.route("**/api/fleet/hosts", (route) =>
    route.fulfill({ json: { scope: "account", hosts: [macA, macB] } }),
  );
  await page.route("**/api/fleet/request", (route) => {
    const { path, hostId } = route.request().postDataJSON();
    if (state.revoked) {
      return route.fulfill({ status: 403, json: { error: "workspace_grant_required" } });
    }
    if (path === "/capabilities") {
      return route.fulfill({
        json: {
          features: ["run-events"],
          control: true,
          workspaces: [{ id: workspaceId, name: "Project" }],
        },
      });
    }
    if (hostId === macB.id && state.macBUnavailable) {
      return route.fulfill({ status: 503, json: { error: "connection_interrupted" } });
    }
    const run = {
      id: runId,
      hostId,
      workspaceId,
      state: "approval",
      createdAt: 1,
      lastSeq: state.lastSeq,
      result: hostId === macA.id ? "Result from Mac A" : "Result from Mac B",
      approval: { id: "a1", tool: "Read", input: { file_path: "test.txt" } },
    };
    if (path === "/runs") return route.fulfill({ json: { runs: [run] } });
    const url = new URL(path, lisa.baseURL);
    expect(url.pathname).toBe("/runs/" + runId + "/events");
    const cursor = Number(url.searchParams.get("after"));
    const reset = cursor > state.lastSeq;
    const after = reset ? 0 : cursor;
    const firstSeq = Math.max(1, state.lastSeq - 499);
    const first = Math.max(firstSeq, after + 1);
    const end = Math.min(first + 99, state.lastSeq);
    const events = Array.from({ length: end - first + 1 }, (_, i) => ({
      type: "turn_started",
      at: 1,
      seq: first + i,
      turn: first + i,
      prompt: "test",
    }));
    return route.fulfill({
      json: {
        run,
        events,
        firstSeq,
        lastSeq: state.lastSeq,
        gap: after < firstSeq - 1,
        reset,
        more: end < state.lastSeq,
      },
    });
  });
  await page.goto(lisa.baseURL + "/fleet");
  await page.getByRole("button", { name: /Mac A/ }).click();
  await expect(page.getByRole("button", { name: "允许这一次" })).toBeEnabled();
  await expect(page.locator("#timeline-list li")).toHaveCount(2);
  return state;
}

test("switching Macs clears the old approval even if the new task list fails", async ({ page }) => {
  const state = await openTask(page);
  await page.getByRole("button", { name: /Mac B/ }).click();
  await expect(page.locator("#notice")).toContainText("连接中断");
  await expect(page.locator("#name")).toHaveText("Mac B");
  await expect(page.locator("#work")).toBeHidden();
  await expect(page.locator("#runs")).toBeEmpty();
  await expect(page.locator("#timeline-list")).toBeEmpty();
  state.macBUnavailable = false;
  await page.clock.fastForward(4000);
  await expect(page.locator("#runs article")).toContainText("Result from Mac B");
  await expect(page.locator("#work")).toBeVisible();
});

test("a late poll cannot reopen the task after an approval receives a revocation", async ({
  page,
}) => {
  const state = await openTask(page);
  // Keep a successful poll in flight while a decision discovers the revocation.
  const pendingList = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/fleet/request") && request.postDataJSON().path === "/runs",
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/fleet/request", async (route) => {
    if (route.request().postDataJSON().path === "/runs") {
      await held;
      await route.fulfill({ json: { runs: [] } });
    } else {
      await route.fallback();
    }
  });
  await page.clock.fastForward(4000);
  const poll = await pendingList;
  state.revoked = true;
  try {
    await page.getByRole("button", { name: "允许这一次" }).click();
    await expect(page.locator("#notice")).toContainText("授权工作区");
  } finally {
    release();
  }
  await (await poll.response())?.finished();
  await expect(page.locator("#work")).toBeHidden();
  await expect(page.locator("#runs")).toBeEmpty();
  await expect(page.locator("#timeline-list")).toBeEmpty();
});

test("polling a revoked task removes its details without a user action", async ({ page }) => {
  const state = await openTask(page);
  state.revoked = true;
  await page.clock.fastForward(4000);
  await expect(page.locator("#notice")).toContainText("授权工作区");
  await expect(page.locator("#work")).toBeHidden();
  await expect(page.locator("#runs")).toBeEmpty();
  await expect(page.locator("#timeline-list")).toBeEmpty();
});

test("a gap replaces the cached prefix and a reset clears its retention notice", async ({
  page,
}) => {
  const state = await openTask(page);
  const rows = page.locator("#timeline-list li");
  state.lastSeq = 505;
  await page.clock.fastForward(4000);
  await expect(rows.last()).toContainText("第 505 轮");
  await expect(rows).toHaveCount(500);
  await expect(rows.first()).toContainText("第 6 轮");
  await expect(page.locator("#timeline-note")).toContainText("从第 6 条开始");
  state.lastSeq = 2;
  await page.clock.fastForward(4000);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("第 1 轮");
  await expect(page.locator("#timeline-note")).toBeEmpty();
});

test("the execution Mac shares only the selected task with a securely paired Pocket and can revoke it", async ({
  page,
}) => {
  let shared = false;
  const pocket = { id: "c".repeat(32), name: "My Pocket", secure: true };
  await page.route("**/api/fleet/hosts", (route) =>
    route.fulfill({ json: { scope: "account", hosts: [] } }),
  );
  await page.route("**/api/fleet/local", (route) =>
    route.fulfill({
      json: {
        link: {
          online: true,
          pending: [],
          devices: [pocket, { id: "d".repeat(32), name: "Old Pocket", secure: false }],
        },
        workspaces: [],
        runs: [],
        shares: [
          {
            id: runId,
            workspaceName: "Project",
            state: "completed",
            createdAt: 1,
            viewers: shared ? [pocket.id] : [],
          },
        ],
      },
    }),
  );
  await page.route("**/api/fleet/shares", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      deviceId: pocket.id,
      runId,
      enabled: !shared,
    });
    shared = !shared;
    return route.fulfill({ json: { shared } });
  });
  await page.goto(lisa.baseURL + "/fleet");
  await page.locator("#local summary").click();
  await expect(page.locator("#shares")).toContainText("Project");
  await expect(page.locator("#shares")).not.toContainText("Old Pocket");
  await page.getByRole("button", { name: /允许查看 · My Pocket/ }).click();
  await expect(page.getByRole("button", { name: /撤销查看 · My Pocket/ })).toBeVisible();
  await page.getByRole("button", { name: /撤销查看 · My Pocket/ }).click();
  await expect(page.getByRole("button", { name: /允许查看 · My Pocket/ })).toBeVisible();
  expect(shared).toBe(false);
});
