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

async function openTask(page: Page, modern = false) {
  const state = {
    lastSeq: 2,
    revoked: false,
    macBUnavailable: true,
    slowDiff: false,
    cleared: false,
    taskState: "approval",
    mayControl: true,
    handoffs: 0,
    slowPreview: false,
    receiver: false,
  };
  let finishDiff: (() => void) | undefined;
  let finishPreview: (() => void) | undefined;
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
          features: [
            "run-events",
            "turn-changes",
            ...(modern ? ["session-capabilities", "agent-handoff"] : []),
          ],
          ...(modern
            ? {
                agents: [
                  { id: "claude-code", start: true, mode: "workspace-edit" },
                  { id: "codex", start: true, mode: "packet-review" },
                ],
              }
            : {}),
          control: true,
          workspaces: [{ id: workspaceId, name: "Project" }],
        },
      });
    }
    if (hostId === macB.id && state.macBUnavailable) {
      return route.fulfill({ status: 503, json: { error: "connection_interrupted" } });
    }
    const run = {
      id: state.receiver ? "9f9e4e5f-960a-4a93-8dc9-b98f0b06bdba" : runId,
      hostId,
      workspaceId,
      state: state.taskState,
      ...(modern
        ? {
            agent: state.receiver ? "codex" : "claude-code",
            capabilities: {
              observe: true,
              append: false,
              cancel: state.mayControl && state.taskState === "approval",
              approve: state.mayControl && state.taskState === "approval",
              resume: false,
              handoff: state.mayControl && state.taskState === "completed",
            },
          }
        : {}),
      createdAt: 1,
      lastSeq: state.lastSeq,
      result: hostId === macA.id ? "Result from Mac A" : "Result from Mac B",
      approval:
        state.taskState === "approval"
          ? { id: "a1", tool: "Read", input: { file_path: "test.txt" } }
          : null,
    };
    if (path === "/runs")
      return route.fulfill({
        json: {
          runs: [run],
          ...(modern
            ? {
                observations: [
                  {
                    workspaceId,
                    agent: "codex",
                    state: "working",
                    capabilities: { observe: true },
                  },
                ],
              }
            : {}),
        },
      });
    if (path.endsWith("/handoff-preview")) {
      const complete = () =>
        route.fulfill({
          json: {
            recipient: { agent: "codex" },
            prompt: "Original request\n+<script>change</script>\nValidation: npm test passed",
            previewToken: "signed-preview",
            expiresAt: Date.now() + 600000,
          },
        });
      if (state.slowPreview) {
        finishPreview = () => {
          void complete();
        };
        return;
      }
      return complete();
    }
    if (path.endsWith("/handoff")) {
      const payload = route.request().postDataJSON().payload;
      expect(payload.agent).toBe("codex");
      expect(payload.previewToken).toBe("signed-preview");
      state.handoffs++;
      state.receiver = true;
      state.taskState = "running";
      return route.fulfill({
        json: { status: "accepted", run: { id: "9f9e4e5f-960a-4a93-8dc9-b98f0b06bdba" } },
      });
    }
    if (path.endsWith("/changes"))
      return route.fulfill({
        json: {
          turns: [
            {
              turn: 1,
              state: state.cleared ? "cleared" : "complete",
              available: !state.cleared,
              reason: state.cleared ? "checkpoints_cleared" : undefined,
            },
          ],
        },
      });
    if (path.endsWith("/changes/1"))
      return route.fulfill({
        json: { concurrent: true, files: [{ id: 0, path: "test.txt", status: "M" }] },
      });
    if (path.endsWith("/changes/1/0")) {
      const complete = () =>
        route.fulfill({ json: { patch: "-old\n+<script>new</script>", truncated: true } });
      if (state.slowDiff) {
        finishDiff = () => {
          void complete();
        };
        return;
      }
      return complete();
    }
    const url = new URL(path, lisa.baseURL);
    expect(url.pathname).toBe("/runs/" + run.id + "/events");
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
  return { state, finishDiff: () => finishDiff?.(), finishPreview: () => finishPreview?.() };
}

test("switching Macs clears the old approval even if the new task list fails", async ({ page }) => {
  const { state } = await openTask(page);
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
  const { state } = await openTask(page);
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
  const { state } = await openTask(page);
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
  const { state } = await openTask(page);
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

test("per-turn diffs label concurrent changes, render safely and clear on revocation", async ({
  page,
}) => {
  const { state } = await openTask(page);
  await page.getByRole("button", { name: "查看第 1 轮改动" }).click();
  await expect(page.locator("#change-note")).toContainText("工作区同时变化");
  await page.getByRole("button", { name: "修改 · test.txt" }).click();
  await expect(page.locator("#change-patch")).toContainText("64 KiB");
  await expect(page.locator("#change-patch")).toContainText("+<script>new</script>");
  expect(await page.locator("#change-patch script").count()).toBe(0);
  state.revoked = true;
  await page.clock.fastForward(4000);
  await expect(page.locator("#changes")).toBeHidden();
  await expect(page.locator("#change-patch")).toBeEmpty();
});

test("a late diff cannot populate another Mac's task", async ({ page }) => {
  const { state, finishDiff } = await openTask(page);
  await page.getByRole("button", { name: "查看第 1 轮改动" }).click();
  state.slowDiff = true;
  const requested = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/fleet/request") && r.postDataJSON()?.path?.endsWith("/changes/1/0"),
  );
  await page.getByRole("button", { name: "修改 · test.txt" }).click();
  await requested;
  await page.getByRole("button", { name: /Mac B/ }).click();
  finishDiff();
  await expect(page.locator("#changes")).toBeHidden();
  await expect(page.locator("#change-patch")).toBeEmpty();
});

test("checkpoint cleanup clears an already displayed diff on the next poll", async ({ page }) => {
  const { state } = await openTask(page);
  await page.getByRole("button", { name: "查看第 1 轮改动" }).click();
  await page.getByRole("button", { name: "修改 · test.txt" }).click();
  await expect(page.locator("#change-patch")).toBeVisible();
  state.cleared = true;
  state.lastSeq++;
  await page.clock.fastForward(4000);
  await expect(page.locator("#change-turns")).toContainText("检查点已清理");
  await expect(page.locator("#change-patch")).toBeEmpty();
  await expect(page.locator("#change-files")).toBeEmpty();
});

test("host actions hide unavailable controls alongside observed sessions", async ({ page }) => {
  const { state } = await openTask(page, true);
  await expect(page.locator("#observations")).toContainText("codex · 外部观察会话");
  await expect(page.locator("#observations button")).toHaveCount(0);
  state.mayControl = false;
  await page.clock.fastForward(4000);
  await expect(page.getByRole("button", { name: "允许这一次" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消此任务" })).toHaveCount(0);
  await expect(page.locator("#follow")).toBeHidden();
});

test("handoff requires a preview and confirmation, and editing invalidates that preview", async ({
  page,
}) => {
  const { state } = await openTask(page, true);
  state.taskState = "completed";
  state.lastSeq++;
  await page.clock.fastForward(4000);
  await page.getByRole("button", { name: "预览跨 agent 交接" }).click();
  await page.getByLabel("验证说明").fill("npm test passed");
  await page.getByRole("button", { name: "生成交接预览" }).click();
  await expect(page.locator("#handoff pre")).toContainText("+<script>change</script>");
  await expect(page.locator("#handoff script")).toHaveCount(0);
  expect(state.handoffs).toBe(0);
  await page.getByLabel("验证说明").fill("not tested");
  await expect(page.getByRole("button", { name: "确认发送交接包" })).toBeHidden();
  await page.getByRole("button", { name: "生成交接预览" }).click();
  await page.getByRole("button", { name: "确认发送交接包" }).click();
  await expect.poll(() => state.handoffs).toBe(1);
  await expect(page.locator("#handoff")).toBeHidden();
  await expect(page.locator("#runs")).toContainText("codex");
});

test("a late handoff preview cannot enable sending on a different Mac", async ({ page }) => {
  const { state, finishPreview } = await openTask(page, true);
  state.taskState = "completed";
  state.lastSeq++;
  await page.clock.fastForward(4000);
  await page.getByRole("button", { name: "预览跨 agent 交接" }).click();
  state.slowPreview = true;
  const requested = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/fleet/request") &&
      r.postDataJSON()?.path?.endsWith("/handoff-preview"),
  );
  await page.getByRole("button", { name: "生成交接预览" }).click();
  await requested;
  await page.getByRole("button", { name: /Mac B/ }).click();
  finishPreview();
  await expect(page.locator("#handoff")).toBeHidden();
  await expect(page.locator("#handoff")).toBeEmpty();
  expect(state.handoffs).toBe(0);
});
