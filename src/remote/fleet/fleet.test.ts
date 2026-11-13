import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { RelayBroker } from "../broker.js";
import { FleetHostService } from "./host-service.js";
import type { ClaudeEvents, ClaudeRunner } from "./claude.js";
import { HOST_API } from "./types.js";

test("operation receipts outlive a backend, reject changed payloads, and never replay a start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-journal-"));
  const home = path.join(dir, "lisa"),
    root = path.join(dir, "project");
  fs.mkdirSync(root);
  let starts = 0;
  let events!: ClaudeEvents;
  const runner: ClaudeRunner = {
    reason: () => null,
    start(_, e) {
      starts++;
      events = e;
      return {
        send() {},
        decide() {},
        cancel() {
          e.exit("");
        },
      };
    },
  };
  const svc = new FleetHostService(home, runner);
  const ws = svc.register("Project", root);
  const peer = {
    hostId: "e".repeat(32),
    deviceId: "b".repeat(32),
    workspaces: [ws.id],
    control: true,
  };
  const body = {
    operationId: crypto.randomUUID(),
    hostId: peer.hostId,
    workspaceId: ws.id,
    text: "Start",
  };
  try {
    assert.throws(
      () => svc.mutate({ ...peer, control: false }, HOST_API + "/runs", body),
      /control_denied/,
    );
    assert.throws(
      () => svc.mutate(peer, HOST_API + "/runs", { ...body, hostId: "d".repeat(32) }),
      /control_denied/,
    );
    svc.mutate(peer, HOST_API + "/runs", body);
    assert.throws(
      () => svc.mutate(peer, HOST_API + "/runs", { ...body, text: "Changed" }),
      /operation_conflict/,
    );
    const second = new FleetHostService(home, runner);
    try {
      const r = second.mutate(peer, HOST_API + "/runs", body) as { run: { state: string } };
      assert.equal(r.run.state, "unknown");
      assert.equal(starts, 1);
      assert.throws(
        () => second.read({ ...peer, deviceId: "other" }, HOST_API + "/runs/" + body.operationId),
        /run_not_found/,
      );
    } finally {
      void second.shutdown();
    }
    events.result("done", false);
    fs.renameSync(root, root + "-old");
    fs.symlinkSync(root + "-old", root);
    assert.throws(
      () =>
        svc.mutate(peer, HOST_API + "/runs/" + body.operationId + "/messages", {
          ...body,
          operationId: crypto.randomUUID(),
        }),
      /workspace_replaced/,
    );
  } finally {
    void svc.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace registration compares real paths without regard to case", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-case-")));
  const home = path.join(dir, "Lisa-Home"),
    project = path.join(dir, "Project");
  fs.mkdirSync(project);
  const runner: ClaudeRunner = {
    reason: () => null,
    start: (_, e) => ({ send() {}, decide() {}, cancel: () => e.exit("") }),
  };
  const svc = new FleetHostService(home, runner);
  // Each path is created first. On a case-insensitive volume it lands inside the
  // existing directory; on a case-sensitive one it is a sibling, refused anyway.
  const make = (...parts: string[]) => {
    const p = path.join(dir, ...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  try {
    const ws = svc.register("Project", project);
    assert.throws(
      () => svc.register("Nested", make("PROJECT", "src")),
      /workspace_overlap_or_limit/,
    );
    assert.throws(
      () => svc.register("Home", make("LISA-HOME", "work")),
      /choose_project_directory/,
    );
    if (fs.existsSync(path.join(dir, "project"))) {
      // The same directory spelled another way is the same workspace, stored as on disk.
      assert.equal(svc.register("Renamed", path.join(dir, "project")).id, ws.id);
      assert.deepEqual(
        svc.workspaces().map((w) => [w.name, w.root]),
        [["Renamed", project]],
      );
    }
  } finally {
    void svc.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface MacListing {
  scope: string;
  hosts: { id: string; name: string; online: boolean; paired: boolean }[];
}
interface OwnerView {
  link: {
    pending: { id: string; code: string; fleet?: boolean; secure: boolean }[];
    devices: { id: string }[];
  };
}
interface Run {
  id: string;
  state: string;
  result: string;
  approval: { id: string } | null;
}

interface Timeline {
  run: Run;
  events: { seq: number; type: string; [field: string]: unknown }[];
  lastSeq: number;
  gap: boolean;
  more: boolean;
}

const realBinary = process.env.LISA_FLEET_TEST_CLAUDE;
test(
  "three independent Macs: scoped pairing, real encrypted controller, approval, result, lost replies, follow-up and cancel",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-macs-")));
    const children: ChildProcess[] = [];
    const calls: string[] = [];
    const readResults: { error: boolean; text: string }[] = [];
    // A standalone executable exercises Seatbelt's native CLI entry point even
    // when the test machine has no installed Claude Code or provider account.
    const fake = path.join(dir, "claude");
    if (!realBinary) {
      const source = fileURLToPath(
        new URL("../../../tests/fixtures/fleet/claude.c", import.meta.url),
      );
      execFileSync("/usr/bin/cc", [source, "-o", fake]);
    }
    async function respond(req: http.IncomingMessage, res: http.ServerResponse) {
      if (req.url === "/api/auth/me" || req.url === "/api/relay/macs") {
        if (req.headers.authorization !== "Bearer test-session") {
          res.writeHead(401);
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url === "/api/auth/me"
              ? { signedIn: true, uid: "alice" }
              : { hosts: broker.list("alice") },
          ),
        );
        return;
      }
      // Real CLI smoke uses a deterministic Anthropic Messages peer, never a live account.
      if (req.url?.startsWith("/v1/messages")) {
        let raw = "";
        for await (const c of req) raw += c;
        const body = JSON.parse(raw);
        const first = body.messages?.some((m: { content: unknown }) =>
          JSON.stringify(m.content).includes("fleet-first"),
        );
        const follow = body.messages?.some((m: { content: unknown }) =>
          JSON.stringify(m.content).includes("fleet-followup"),
        );
        const hasResult = body.messages?.some((m: { content: unknown }) =>
          JSON.stringify(m.content).includes('"tool_result"'),
        );
        const history = JSON.stringify(body.messages);
        // Keep a real model stream open to exercise cancellation mid-turn.
        if (history.includes("fleet-hold")) {
          calls.push("hold");
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          return;
        }
        const browserTurn = history.includes("browser-probe");
        const read = history.includes("read-probe");
        if (read)
          for (const m of body.messages as { content: unknown }[])
            for (const block of Array.isArray(m.content) ? m.content : [])
              if (block.type === "tool_result")
                readResults.push({
                  error: block.is_error === true,
                  text: JSON.stringify(block.content),
                });
        const toolName = read ? "Read" : "Edit";
        const tool =
          first &&
          !hasResult &&
          !follow &&
          body.tools?.some((t: { name: string }) => t.name === toolName);
        calls.push(tool ? "tool" : "text");
        const output = follow ? "followup 2" : "first complete";
        const content = tool
          ? {
              type: "tool_use",
              id: "toolu_fixture",
              name: toolName,
              input: read
                ? { file_path: path.join(dir, "project-1", "approved.txt") }
                : {
                    file_path: path.join(
                      dir,
                      "project-1",
                      browserTurn ? "browser-approved.txt" : "approved.txt",
                    ),
                    old_string: "",
                    new_string: "approved",
                  },
            }
          : { type: "text", text: output };
        const message = {
          type: "message",
          role: "assistant",
          model: body.model,
          id: "msg_" + crypto.randomUUID(),
          content: [content],
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        };
        if (!body.stream) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(message));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, fields: object) =>
          res.write("event: " + type + "\ndata: " + JSON.stringify({ type, ...fields }) + "\n\n");
        event("message_start", { message: { ...message, content: [], stop_reason: null } });
        event("content_block_start", {
          index: 0,
          content_block: tool ? { ...content, input: {} } : { type: "text", text: "" },
        });
        event("content_block_delta", {
          index: 0,
          delta: tool
            ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
            : { type: "text_delta", text: output },
        });
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 10 },
        });
        event("message_stop", {});
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("{}");
    }
    const cloud = http.createServer((req, res) => {
      void respond(req, res).catch(() => res.destroy());
    });
    const broker = new RelayBroker(cloud, async (t) =>
      t === "test-session" ? { uid: "alice", expiresAt: Date.now() + 600000 } : null,
    );
    await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + (cloud.address() as { port: number }).port;
    const api = async <T = unknown>(port: number, url: string, body?: object) => {
      const res = await fetch(
        "http://127.0.0.1:" + port + url,
        body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {},
      );
      const data: unknown = await res.json();
      if (!res.ok)
        throw Object.assign(Error(String((data as { error?: string })?.error || res.statusText)), {
          status: res.status,
        });
      return data as T;
    };
    const until = async <T>(f: () => Promise<T>, check: (t: T) => boolean) => {
      let last: T | undefined;
      for (let i = 0; i < 150; i++) {
        last = await f();
        if (check(last)) return last;
        await wait(120);
      }
      throw Error(
        "condition timed out: " + JSON.stringify(last) + "; upstream calls " + calls.join(","),
      );
    };
    async function backend(i: number) {
      const home = path.join(dir, "mac-" + i);
      fs.mkdirSync(home);
      fs.writeFileSync(
        path.join(home, "agents.json"),
        JSON.stringify({ integrations: { "claude-code": { enabled: false } } }),
      );
      const child = fork(new URL("../../../tests/fixtures/fleet/backend.ts", import.meta.url), [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: {
          PATH: process.env.PATH,
          TMPDIR: os.tmpdir(),
          LISA_HOME: home,
          LISA_MANAGED_BASE: base,
          LISA_MANAGED_SESSION: "test-session",
          CLAUDE_HOME: home,
          CLAUDE_CONFIG_DIR: home,
          LISA_MAIL_POLL_MINUTES: "0",
          LISA_SOUL_GIT: "0",
          ANTHROPIC_API_KEY: "sk-ant-fixture",
          ANTHROPIC_BASE_URL: base,
          LISA_PTY_CLAUDE_CMD: realBinary || fake,
        },
      });
      children.push(child);
      const [port] = await once(child, "message");
      if (i === 0) return { port, id: "", workspace: "" };
      const status = await api<{ hostId: string }>(port, "/api/remote/connect", {});
      const root = path.join(dir, "project-" + i);
      fs.mkdirSync(root, { recursive: true });
      const w = await api<{ id: string }>(port, "/api/fleet/workspaces", {
        name: "Project",
        directory: root,
      });
      return { port, id: status.hostId, workspace: w.id };
    }
    try {
      const [controller, ...macs] = await Promise.all([0, 1, 2, 3].map(backend));
      await api(controller!.port, "/api/remote/connect", {});
      const alternate = path.join(dir, "alternate");
      fs.mkdirSync(alternate);
      const second = await api<{ id: string }>(macs[0]!.port, "/api/fleet/workspaces", {
        name: "Alternate",
        directory: alternate,
      });
      const foreign = await fetch("http://127.0.0.1:" + controller!.port + "/api/fleet/local", {
        headers: { Origin: "https://untrusted.example" },
      });
      assert.equal(foreign.status, 403);
      const unsigned = await fetch(
        "http://127.0.0.1:" + macs[0]!.port + HOST_API + "/capabilities",
      );
      assert.equal(unsigned.status, 403);
      const list = () => api<MacListing>(controller!.port, "/api/fleet/hosts");
      const initial = await until(list, (l) => l.hosts.length === 3);
      assert.equal(new Set(initial.hosts.map((h) => h.id)).size, 3);
      assert.equal(new Set(initial.hosts.map((h) => h.name)).size, 1);
      const remote = <T = { run: Run }>(
        i: number,
        route: string,
        method = "GET",
        payload?: object,
      ) =>
        api<T>(controller!.port, "/api/fleet/request", {
          scope: initial.scope,
          hostId: macs[i]!.id,
          path: route,
          method,
          payload,
        });
      for (const [i, m] of macs.entries()) {
        const p = await api<{ code: string }>(controller!.port, "/api/fleet/pair", {
          hostId: m.id,
        });
        const local = await api<OwnerView>(m.port, "/api/fleet/local");
        const req = local.link.pending.find((x) => x.code === p.code && x.fleet);
        assert.ok(req);
        assert.equal(req.secure, true);
        await assert.rejects(api(m.port, "/api/remote/approve", { id: req.id, code: req.code }));
        await api(m.port, "/api/fleet/grants", {
          deviceId: req.id,
          code: req.code,
          control: i === 0,
          workspaces: i === 0 ? [m.workspace, second.id] : [m.workspace],
        });
        await api(controller!.port, "/api/fleet/pair", { hostId: m.id, code: p.code });
      }
      const m = macs[0]!,
        operationId = crypto.randomUUID();
      const start = { operationId, hostId: m.id, workspaceId: m.workspace, text: "fleet-first" };
      // Lose the entire application response after the command reached the host.
      await remote(0, "/runs", "POST", start);
      const replay = await remote(0, "/runs", "POST", start);
      const id = replay.run.id;
      assert.equal((await remote(0, "/operations/" + operationId)).run.id, id);
      assert.equal((await remote<{ runs: Run[] }>(0, "/runs")).runs.length, 1);
      assert.equal((await remote<{ runs: Run[] }>(1, "/runs")).runs.length, 0);
      await assert.rejects(
        remote(1, "/runs", "POST", {
          ...start,
          hostId: macs[1]!.id,
          workspaceId: macs[1]!.workspace,
        }),
        /control_denied/,
      );
      const run = async () => (await remote(0, "/runs/" + id)).run;
      const pending = await until(run, (r) => !!r.approval || r.state === "failed");
      assert.ok(pending.approval, "expected approval; got " + JSON.stringify(pending));
      assert.equal(fs.existsSync(path.join(dir, "project-1", "approved.txt")), false);
      // The executor records the agent's process group, so a later backend can stop it.
      const ledger = new DatabaseSync(path.join(dir, "mac-1", "fleet", "runs.sqlite"));
      try {
        const row = ledger.prepare("SELECT pgid,started FROM runs WHERE id=?").get(id);
        assert.ok(Number(row?.pgid) > 1 && Number(row?.started) > 0, JSON.stringify(row));
      } finally {
        ledger.close();
      }
      // The controller's cursor before it loses the connection.
      const seen = (await remote<Timeline>(0, "/runs/" + id + "/events")).lastSeq;
      await api(m.port, "/api/remote/disconnect", {});
      const away = await until(list, (l) => l.hosts.filter((h) => h.online).length === 2);
      assert.ok(away.hosts.some((h) => h.id === m.id && h.paired && !h.online));
      assert.equal((await remote<{ runs: Run[] }>(1, "/runs")).runs.length, 0);
      await assert.rejects(remote(0, "/runs/" + id), /connection_interrupted/);
      await api(m.port, "/api/remote/connect", {});
      await until(list, (l) => l.hosts.every((h) => h.online));
      assert.equal((await run()).approval?.id, pending.approval.id);
      const decision = {
        ...start,
        operationId: crypto.randomUUID(),
        approvalId: pending.approval.id,
        allow: true,
      };
      await assert.rejects(
        remote(0, "/runs/" + id + "/decisions", "POST", { ...decision, allow: "yes" }),
        /boolean_decision_required/,
      );
      await assert.rejects(
        remote(0, "/runs/" + id + "/decisions", "POST", {
          ...decision,
          approvalId: crypto.randomUUID(),
        }),
        /stale_approval/,
      );
      await remote(0, "/runs/" + id + "/decisions", "POST", decision);
      await remote(0, "/runs/" + id + "/decisions", "POST", decision);
      await until(run, (r) => r.state === "waiting" && r.result === "first complete");
      assert.equal(
        fs.readFileSync(path.join(dir, "project-1", "approved.txt"), "utf8"),
        "approved",
      );
      const follow = { ...start, operationId: crypto.randomUUID(), text: "fleet-followup" };
      await remote(0, "/runs/" + id + "/messages", "POST", follow);
      await remote(0, "/runs/" + id + "/messages", "POST", follow);
      await until(run, (r) => r.state === "waiting" && r.result === "followup 2");
      await remote(0, "/runs/" + id + "/messages", "POST", {
        ...start,
        operationId: crypto.randomUUID(),
        text: "fleet-hold",
      });
      await until(run, (r) => r.state === "running" && (!realBinary || calls.includes("hold")));
      const cancel = { ...start, operationId: crypto.randomUUID() };
      await remote(0, "/runs/" + id + "/cancel", "POST", cancel);
      await remote(0, "/runs/" + id + "/cancel", "POST", cancel);
      await until(run, (r) => r.state === "cancelled");
      // One cursor read over the encrypted relay returns what happened since, once each
      // and in order, although every command above was sent twice.
      const missed = await remote<Timeline>(0, "/runs/" + id + "/events?after=" + seen);
      const steps = missed.events.filter((e) => e.type !== "tool_blocked");
      assert.equal(missed.events[0]!.seq, seen + 1);
      assert.deepEqual(
        steps.map((e) => e.type),
        [
          "approval_resolved",
          "turn_completed",
          "turn_started",
          "turn_completed",
          "turn_started",
          "cancel_requested",
          "run_ended",
        ],
      );
      assert.deepEqual(
        [steps[0]!.outcome, steps[1]!.result, steps[3]!.result, steps[6]!.state],
        ["allowed", "first complete", "followup 2", "cancelled"],
      );
      assert.deepEqual([missed.gap, missed.more, missed.run.state], [false, false, "cancelled"]);
      const whole = await remote<Timeline>(0, "/runs/" + id + "/events?after=0&limit=2");
      assert.deepEqual(
        [whole.events.map((e) => e.type), whole.more],
        [["turn_started", "approval_requested"], true],
      );
      assert.equal(whole.events[1]!.target, "approved.txt");
      // Another Mac holds none of this task's history.
      await assert.rejects(remote(1, "/runs/" + id + "/events"), /run_not_found/);
      if (realBinary) assert.ok(calls.includes("tool"));
      if (process.env.LISA_FLEET_TEST_BROWSER === "1") {
        const { chromium, expect } = await import("@playwright/test");
        const browser = await chromium.launch({ channel: "chrome", headless: true });
        try {
          const page = await browser.newPage();
          await page.goto("http://127.0.0.1:" + controller!.port);
          await page.getByRole("link", { name: /Remote Macs/ }).click();
          await expect(page.locator("#hosts button")).toHaveCount(3);
          const selectHost = () =>
            page
              .locator("#hosts button")
              .filter({ hasText: m.id.slice(0, 8) })
              .click();
          await selectHost();
          await page.locator("#workspace").selectOption(m.workspace);
          await expect(page.locator("#workspace option:checked")).toHaveText("Project");
          let dropped = false,
            starts = 0;
          await page.route("**/api/fleet/request", async (route) => {
            const b = route.request().postDataJSON();
            if (b.path === "/runs" && b.method === "POST") {
              starts++;
              if (!dropped) {
                await route.fetch();
                dropped = true;
                await route.abort("connectionreset");
                return;
              }
            }
            await route.continue();
          });
          await page.locator("#prompt").fill("fleet-first browser-probe");
          await page.getByRole("button", { name: "启动 Claude Code", exact: true }).click();
          await expect(page.locator("#retry")).toBeEnabled();
          // A page reload drops all JS state. The receipt lookup must still use its original target.
          await page.reload();
          await selectHost();
          await expect(page.locator("#workspace")).toHaveValue(m.workspace);
          await page.locator("#workspace").selectOption(second.id);
          await expect(page.locator("#retry")).toBeDisabled();
          await page.locator("#workspace").selectOption(m.workspace);
          await page.locator("#retry").click();
          await expect(page.getByRole("button", { name: "拒绝", exact: true })).toBeVisible({
            timeout: 15000,
          });
          await page.getByRole("button", { name: "拒绝", exact: true }).click();
          await expect(page.locator("#runs pre")).toHaveText("first complete", { timeout: 12000 });
          assert.equal(fs.existsSync(path.join(dir, "project-1", "browser-approved.txt")), false);
          const timeline = page.locator("#timeline-list");
          await expect(timeline.locator("li").first()).toContainText("第 1 轮开始");
          await expect(timeline).toContainText("审批结果 · 已拒绝");
          await expect(timeline).toContainText("第 1 轮完成");
          await page.locator("#prompt").fill("fleet-followup browser");
          await page.locator("#follow").click();
          await expect(page.locator("#runs pre")).toHaveText("followup 2", { timeout: 12000 });
          await page.getByRole("button", { name: "取消此任务" }).click();
          await expect(page.locator("#runs strong")).toHaveText("已取消", { timeout: 12000 });
          await expect(timeline).toContainText("第 2 轮完成");
          await expect(timeline).toContainText("任务结束 · 已取消", { timeout: 12000 });
          // A reload drops the page's cursor. The history is read again from the Mac.
          await page.reload();
          await selectHost();
          await page.locator("#workspace").selectOption(m.workspace);
          const newest = (await remote<{ runs: Run[] }>(0, "/runs")).runs[0]!;
          const recorded = await remote<Timeline>(0, "/runs/" + newest.id + "/events");
          await expect(timeline.locator("li")).toHaveCount(recorded.events.length, {
            timeout: 12000,
          });
          await expect(timeline.locator("li").first()).toContainText("第 1 轮开始");
          await expect(timeline.locator("li").last()).toContainText("任务结束 · 已取消");
          assert.equal(starts, 1);
          assert.equal((await remote<{ runs: Run[] }>(0, "/runs")).runs.length, 2);
        } finally {
          await browser.close();
        }
      }
      if (realBinary) {
        const probe = {
          ...start,
          operationId: crypto.randomUUID(),
          text: "fleet-first read-probe",
        };
        await remote(0, "/runs", "POST", probe);
        const probePath = "/runs/" + probe.operationId;
        const view = async () => (await remote(0, probePath)).run;
        const p = await until(view, (r) => r.state !== "running");
        assert.equal(p.state, "approval", "Read must also pause before returning project content");
        await remote(0, probePath + "/decisions", "POST", {
          ...probe,
          operationId: crypto.randomUUID(),
          approvalId: p.approval!.id,
          allow: true,
        });
        await until(view, (r) => r.state === "waiting");
        // The approved Read returned the file's content from inside the sandbox.
        assert.ok(readResults.length > 0, "the model never received the Read result");
        assert.deepEqual(
          readResults.filter((r) => r.error || !/approved(?!\.txt)/.test(r.text)),
          [],
        );
        await remote(0, probePath + "/cancel", "POST", {
          ...probe,
          operationId: crypto.randomUUID(),
        });
        await until(view, (r) => r.state === "cancelled");
      }
      // Switching remote control off, or revoking the device, stops what it left
      // running on the Mac instead of only hiding it from the controller.
      const active = async () =>
        (await api<{ runs: { id: string }[] }>(m.port, "/api/fleet/local")).runs;
      const hold = async () => {
        const op = { ...start, operationId: crypto.randomUUID(), text: "fleet-hold" };
        await remote(0, "/runs", "POST", op);
        await until(active, (runs) => runs.some((r) => r.id === op.operationId));
        return op.operationId;
      };
      const halted = await hold();
      await api(m.port, "/api/control/policy", { remoteControl: false });
      await until(active, (runs) => runs.length === 0);
      await api(m.port, "/api/control/policy", { remoteControl: true });
      assert.equal((await remote(0, "/runs/" + halted)).run.state, "cancelled");
      const orphaned = await hold();
      const device = (await api<OwnerView>(m.port, "/api/fleet/local")).link.devices[0]!;
      await api(m.port, "/api/remote/revoke", { id: device.id });
      await until(active, (runs) => runs.length === 0);
      const after = new DatabaseSync(path.join(dir, "mac-1", "fleet", "runs.sqlite"));
      try {
        assert.equal(
          after.prepare("SELECT state FROM runs WHERE id=?").get(orphaned)?.state,
          "cancelled",
        );
      } finally {
        after.close();
      }
      await assert.rejects(remote(0, "/runs"), /workspace_grant_required/);
      await assert.rejects(remote(0, "/runs/" + id + "/events"), /workspace_grant_required/);
      assert.equal((await remote<{ control: boolean }>(2, "/capabilities")).control, false);
    } finally {
      await Promise.all(
        children.map(async (c) => {
          const closed = once(c, "exit");
          c.kill();
          await closed;
        }),
      );
      broker.close();
      cloud.closeAllConnections();
      await new Promise<void>((r) => cloud.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
