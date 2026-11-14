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
    restores: 0,
    slowRestore: false,
    operationGeneration: "",
    emptyLedger: false,
    continuations: 0,
    slowContinuation: false,
  };
  let finishDiff: (() => void) | undefined;
  let finishPreview: (() => void) | undefined;
  let finishRestore: (() => void) | undefined;
  let finishContinuation: (() => void) | undefined;
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
            ...(modern
              ? ["session-capabilities", "agent-handoff", "file-restore", "task-continuation"]
              : []),
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
          operationGeneration: state.operationGeneration,
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
              resume: state.mayControl && state.taskState === "unknown",
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
          runs: state.emptyLedger ? [] : [run],
          operationGeneration: state.operationGeneration,
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
    if (path.endsWith("/continue-preview")) {
      const complete = () =>
        route.fulfill({
          json: {
            prompt:
              "UNKNOWN old outcome\nNEW instruction: " +
              route.request().postDataJSON().payload.text,
            previewToken: "continuation-token",
            expiresAt: Date.now() + 600000,
          },
        });
      if (state.slowContinuation) {
        finishContinuation = () => {
          void complete();
        };
        return;
      }
      return complete();
    }
    if (path.endsWith("/continue")) {
      expect(route.request().postDataJSON().payload.previewToken).toBe("continuation-token");
      state.continuations++;
      state.taskState = "running";
      return route.fulfill({ json: { status: "accepted", run } });
    }
    if (path.endsWith("/restore-preview")) {
      const complete = () =>
        route.fulfill({
          json: {
            path: "test.txt",
            turn: 1,
            file: 0,
            current: {
              exists: true,
              text: "current <script>value</script>",
              bytes: 30,
              mode: 420,
              sha256: "current",
            },
            target: { exists: true, text: "previous", bytes: 8, mode: 420, sha256: "previous" },
            previewToken: "restore-token",
            expiresAt: Date.now() + 600000,
          },
        });
      if (state.slowRestore) {
        finishRestore = () => {
          void complete();
        };
        return;
      }
      return complete();
    }
    if (path.endsWith("/restore")) {
      expect(route.request().postDataJSON().payload).toMatchObject({
        hostId: macA.id,
        workspaceId,
        turn: 1,
        file: 0,
        previewToken: "restore-token",
      });
      state.restores++;
      state.lastSeq++;
      return route.fulfill({ json: { status: "accepted", run } });
    }
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
  return {
    state,
    finishDiff: () => finishDiff?.(),
    finishPreview: () => finishPreview?.(),
    finishRestore: () => finishRestore?.(),
    finishContinuation: () => finishContinuation?.(),
  };
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
  let shared = false,
    approved = false;
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
            approvers: approved ? [pocket.id] : [],
          },
        ],
      },
    }),
  );
  await page.route("**/api/fleet/shares", (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON();
    if (body.approve !== undefined) {
      expect(body).toEqual({ deviceId: pocket.id, runId, enabled: true, approve: !approved });
      approved = body.approve;
    } else {
      expect(body).toEqual({ deviceId: pocket.id, runId, enabled: !shared });
      shared = !shared;
      approved = false;
    }
    return route.fulfill({ json: { shared } });
  });
  await page.goto(lisa.baseURL + "/fleet");
  await page.locator("#local summary").click();
  await expect(page.locator("#shares")).toContainText("Project");
  await expect(page.locator("#shares")).not.toContainText("Old Pocket");
  await page.getByRole("button", { name: /允许查看 · My Pocket/ }).click();
  await expect(page.getByRole("button", { name: /撤销查看 · My Pocket/ })).toBeVisible();
  expect(approved).toBe(false);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /允许审批 · My Pocket/ }).click();
  expect(approved).toBe(false);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /允许审批 · My Pocket/ }).click();
  await expect(page.getByRole("button", { name: /撤销审批 · My Pocket/ })).toBeVisible();
  expect(approved).toBe(true);
  await page.getByRole("button", { name: /撤销审批 · My Pocket/ }).click();
  await expect(page.getByRole("button", { name: /允许审批 · My Pocket/ })).toBeVisible();
  expect(shared).toBe(true);
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

test("file restore requires exact preview and confirmation without changing other tasks", async ({
  page,
}) => {
  const { state } = await openTask(page, true);
  state.taskState = "completed";
  state.lastSeq++;
  await page.clock.fastForward(4000);
  await page.getByRole("button", { name: "查看第 1 轮改动" }).click();
  await page.getByRole("button", { name: "修改 · test.txt" }).click();
  await expect(page.getByRole("button", { name: "确认回退此文件" })).toHaveCount(0);
  await page.getByRole("button", { name: "预览回退此文件" }).click();
  await expect(page.locator("#restore")).toContainText("current <script>value</script>");
  await expect(page.locator("#restore script")).toHaveCount(0);
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "确认回退此文件" }).click();
  expect(state.restores).toBe(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "确认回退此文件" }).click();
  await expect(page.locator("#notice")).toContainText("操作已接收");
  expect(state.restores).toBe(1);
});

test("a restore preview arriving after switching Macs cannot enable file writes", async ({
  page,
}) => {
  const { state, finishRestore } = await openTask(page, true);
  state.taskState = "completed";
  state.lastSeq++;
  await page.clock.fastForward(4000);
  await page.getByRole("button", { name: "查看第 1 轮改动" }).click();
  await page.getByRole("button", { name: "修改 · test.txt" }).click();
  state.slowRestore = true;
  const requested = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/fleet/request") &&
      r.postDataJSON()?.path?.endsWith("/restore-preview"),
  );
  await page.getByRole("button", { name: "预览回退此文件" }).click();
  await requested;
  await page.getByRole("button", { name: /Mac B/ }).click();
  finishRestore();
  await expect(page.locator("#restore")).toBeHidden();
  await expect(page.locator("#restore")).toBeEmpty();
  expect(state.restores).toBe(0);
});

test("cleanup generations invalidate old browser retries while new operations use the fresh generation", async ({
  page,
}) => {
  const { state } = await openTask(page, true);
  const payloads: { operationGeneration: string; operationId: string }[] = [];
  let newGeneration: string | undefined;
  await page.route("**/api/fleet/request", async (route) => {
    const body = route.request().postDataJSON();
    if (body.path.endsWith("/decisions")) {
      payloads.push(body.payload);
      if (payloads.length === 1) return route.abort();
      return route.fulfill({ status: 409, json: { error: "operation_generation_changed" } });
    }
    if (body.path.startsWith("/operations/"))
      return route.fulfill({ status: 404, json: { error: "operation_not_found" } });
    if (body.path === "/runs" && body.method === "POST") {
      newGeneration = body.payload.operationGeneration;
      return route.fulfill({ json: { status: "accepted", run: { id: runId } } });
    }
    return route.fallback();
  });
  await page.getByRole("button", { name: "允许这一次" }).click();
  await expect(page.locator("#retry")).toBeEnabled();
  state.operationGeneration = "after-cleanup";
  state.emptyLedger = true;
  await page.clock.fastForward(4000);
  await expect(page.locator("#notice")).toContainText("账本已清理");
  await expect(page.locator("#timeline-list")).toBeEmpty();
  await page.locator("#retry").click();
  await expect(page.locator("#notice")).toContainText("旧操作不会重放");
  await expect.poll(() => payloads.length).toBe(2);
  await expect(page.locator("#retry")).toBeHidden();
  expect(payloads[0]).toEqual(payloads[1]);
  expect(payloads[1]!.operationGeneration).toBe("");
  await page.locator("#prompt").fill("explicit new task");
  await page.locator("#start").click();
  await expect(page.locator("#notice")).toContainText("操作已接收");
  expect(newGeneration).toBe("after-cleanup");
});

test("owner storage cleanup requires a preview and explicit confirmation", async ({ page }) => {
  let cleared = 0;
  await page.route("**/api/fleet/hosts", (route) =>
    route.fulfill({ json: { scope: "account", hosts: [] } }),
  );
  await page.route("**/api/fleet/local", (route) =>
    route.fulfill({
      json: {
        link: { online: true, pending: [], devices: [] },
        workspaces: [],
        runs: [],
        shares: [],
        storage: {
          quotaMiB: 512,
          retentionDays: 0,
          usedBytes: 4096,
          runs: cleared ? 0 : 2,
          receipts: 3,
        },
      },
    }),
  );
  await page.route("**/api/fleet/ledger/preview", (route) =>
    route.fulfill({
      json: {
        runs: 2,
        receipts: 3,
        usedBytes: 4096,
        previewToken: "bound-cleanup",
        expiresAt: Date.now() + 600000,
      },
    }),
  );
  await page.route("**/api/fleet/ledger/clear", (route) => {
    expect(route.request().postDataJSON().previewToken).toBe("bound-cleanup");
    cleared++;
    return route.fulfill({ json: { cleared: true, compacted: true } });
  });
  await page.goto(lisa.baseURL + "/fleet");
  await page.locator("#local summary").click();
  await expect(page.getByRole("button", { name: "确认清理全部任务记录" })).toHaveCount(0);
  await page.getByRole("button", { name: "预览完整账本清理" }).click();
  await expect(page.locator("#storage")).toContainText("2 个任务、3 个回执");
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "确认清理全部任务记录" }).click();
  expect(cleared).toBe(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "确认清理全部任务记录" }).click();
  await expect(page.getByRole("button", { name: "确认清理全部任务记录" })).toHaveCount(0);
  expect(cleared).toBe(1);
});

test("continuation requires new instructions and a fresh preview after edits", async ({ page }) => {
  const { state } = await openTask(page, true);
  state.taskState = "unknown";
  state.lastSeq++;
  await page.clock.fastForward(4000);
  await page.getByRole("button", { name: "从已保存上下文续接" }).click();
  await expect(page.getByRole("button", { name: "预览续接上下文" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认开始新的续接任务" })).toBeDisabled();
  await page.getByLabel("续接的新指令").fill("Inspect before editing.");
  await page.getByRole("button", { name: "预览续接上下文" }).click();
  await expect(page.locator("#handoff pre")).toContainText("UNKNOWN old outcome");
  await expect(page.getByRole("button", { name: "确认开始新的续接任务" })).toBeEnabled();
  await page.getByLabel("续接的新指令").fill("Only explain.");
  await expect(page.getByRole("button", { name: "确认开始新的续接任务" })).toBeDisabled();
  await expect(page.locator("#handoff pre")).toBeEmpty();
  await page.getByRole("button", { name: "预览续接上下文" }).click();
  await page.getByRole("button", { name: "确认开始新的续接任务" }).click();
  await expect(page.locator("#notice")).toContainText("操作已接收");
  expect(state.continuations).toBe(1);
});

test("a late continuation preview cannot start work on another Mac", async ({ page }) => {
  const { state, finishContinuation } = await openTask(page, true);
  state.taskState = "unknown";
  state.lastSeq++;
  state.slowContinuation = true;
  await page.clock.fastForward(4000);
  await page.getByRole("button", { name: "从已保存上下文续接" }).click();
  await page.getByLabel("续接的新指令").fill("Inspect first.");
  const requested = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/fleet/request") &&
      r.postDataJSON()?.path?.endsWith("/continue-preview"),
  );
  await page.getByRole("button", { name: "预览续接上下文" }).click();
  await requested;
  await page.getByRole("button", { name: /Mac B/ }).click();
  finishContinuation();
  await expect(page.locator("#handoff")).toBeEmpty();
  expect(state.continuations).toBe(0);
});
