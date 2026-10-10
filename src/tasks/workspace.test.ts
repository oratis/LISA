/**
 * Each task run works in its own folder under the Lisa home, and nothing else
 * in the Lisa home is writable from it (review of #422, H2). Temp homes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { homeScope } from "../paths.js";
import type { Provider, ProviderResult, ProviderRunOpts } from "../providers/types.js";
import { buildMacosSeatbeltPolicy } from "../sandbox/macos.js";
import { bashTool } from "../tools/bash.js";
import { WardenInbox } from "../warden/inbox.js";
import { createWardenSession } from "../warden/session.js";
import { createTaskApprovalFactory } from "../warden/task-approval.js";
import { confirmationKey, confirmTask } from "./confirmation.js";
import { removeTask } from "./removal.js";
import { TaskRunner, taskCapabilities } from "./runner.js";
import { createTask, getTask, TaskGoneError, updateTask } from "./store.js";
import { ensureTaskWorkspace, taskWorkspaceDir } from "./workspace.js";

process.env.LISA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-task-ws-global-"));
process.env.LISA_SECRETS_BACKEND = "file";

/** A user home with the Lisa home inside it, like ~/.lisa. */
async function withUserHome<T>(fn: (userHome: string, home: string) => Promise<T>): Promise<T> {
  const userHome = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-task-ws-")));
  const home = path.join(userHome, ".lisa");
  await fsp.mkdir(home);
  try {
    return await homeScope.run(home, () => fn(userHome, home));
  } finally {
    await fsp.rm(userHome, { recursive: true, force: true });
  }
}

let idN = 0;
const call = (name: string, input: unknown): Anthropic.ContentBlock =>
  ({ type: "tool_use", id: `tu_${++idN}`, name, input }) as Anthropic.ContentBlock;
const turn = (content: Anthropic.ContentBlock[]): ProviderResult => ({
  content,
  stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
  usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const lastToolResult = (o: ProviderRunOpts): string => {
  const last = o.messages.at(-1);
  if (!last || typeof last.content === "string") return "";
  return last.content
    .flatMap((b) =>
      b.type === "tool_result"
        ? [typeof b.content === "string" ? b.content : JSON.stringify(b.content)]
        : [],
    )
    .join("\n");
};

test("the task's folder is created under the Lisa home, never re-creates a deleted home, and goes with the task", async () => {
  await withUserHome(async (_userHome, home) => {
    const task = await createTask({
      kind: "oneoff",
      title: "x",
      instruction: "x",
      origin: { kind: "api" },
    });
    const ws = await ensureTaskWorkspace(task.id);
    assert.equal(ws, await fsp.realpath(path.join(home, "task-workspaces", task.id)));
    assert.equal(await ensureTaskWorkspace(task.id), ws, "idempotent");
    await fsp.writeFile(path.join(ws, "notes.md"), "kept between runs");
    await removeTask(task.id);
    assert.equal(fs.existsSync(ws), false, "removed with the task");

    await homeScope.run(path.join(home, "deleted-account"), async () => {
      await assert.rejects(ensureTaskWorkspace(task.id), TaskGoneError);
      assert.equal(fs.existsSync(path.join(home, "deleted-account")), false);
    });
    assert.throws(() => taskWorkspaceDir("../escape"));
  });
});

test("a task run's file tools may write its folder and nothing else in the Lisa home", async () => {
  await withUserHome(async (_userHome, home) => {
    const ws = await ensureTaskWorkspace("t_000000000001");
    assert.equal(taskCapabilities(ws, "danger-full-access"), undefined);
    const caps = taskCapabilities(ws, "workspace-write")!;
    await caps.fs.writeFile(path.join(ws, "out.txt"), "ok");
    assert.equal(await fsp.readFile(path.join(ws, "out.txt"), "utf8"), "ok");
    await fsp.mkdir(path.join(home, "tasks"), { recursive: true });
    for (const target of [
      path.join(home, "tasks", "t_other.json"),
      path.join(home, "config.env"),
      path.join(home, "task-workspaces", "t_000000000002", "x.txt"),
    ]) {
      await assert.rejects(caps.fs.writeFile(target, "{}"), /confines writes/, target);
    }
  });
});

test("the Seatbelt profile denies the Lisa home after every allow, then re-opens only the task's folder", () => {
  const profile = buildMacosSeatbeltPolicy({
    cwd: "/Users/u/.lisa/task-workspaces/t_1",
    allowNetwork: true,
    mode: "workspace-write",
    denyWrites: { paths: ["/Users/u/.lisa"], except: "/Users/u/.lisa/task-workspaces/t_1" },
    denyPaths: ["/Users/u/.lisa/warden"],
  });
  const lines = profile.split("\n");
  const at = (line: string) => lines.indexOf(line);
  const deny = at('(deny file-write* (subpath "/Users/u/.lisa"))');
  const except = lines.lastIndexOf(
    '(allow file-write* (subpath "/Users/u/.lisa/task-workspaces/t_1"))',
  );
  assert.ok(deny > at('(allow file-write* (subpath "/private/var/folders"))'));
  assert.ok(except > deny, "the exception comes after the denial (last match wins)");
  assert.ok(
    at('(deny file-read* file-write* (subpath "/Users/u/.lisa/warden"))') > except,
    "Warden's directory stays denied whatever is re-opened",
  );
  // A read-only profile has nothing to deny writes in.
  assert.ok(
    !buildMacosSeatbeltPolicy({
      cwd: "/w",
      allowNetwork: false,
      mode: "read-only",
      denyWrites: { paths: ["/Users/u/.lisa"] },
    }).includes("/Users/u/.lisa"),
  );
});

// ── probe p4: a pre-approved shell with a broad server cwd ──

test(
  "a pre-approved bash runs in the task's folder and cannot rewrite another task's file",
  { skip: process.platform !== "darwin" ? "the real Seatbelt sandbox is macOS-only" : false },
  async () => {
    await withUserHome(async (userHome, home) => {
      const victim = await createTask({
        kind: "routine",
        title: "dormant",
        instruction: "x",
        origin: { kind: "chat" },
        schedule: { expr: "daily:09:00", tz: "UTC" },
        enabled: false,
      });
      const victimFile = path.join(home, "tasks", `${victim.id}.json`);
      const before = await fsp.readFile(victimFile, "utf8");
      const digest = await createTask({
        kind: "routine",
        title: "Digest",
        instruction: "x",
        origin: { kind: "chat" },
        schedule: { expr: "daily:08:00", tz: "UTC" },
        envelope: { tools: ["bash"] },
        enabled: true,
        state: "scheduled",
        nextRunAt: Date.now() - 1,
      });
      // The user confirmed it: bash is pre-approved, so only the sandbox stands in the way.
      const signing = (await confirmationKey({ create: true }))!;
      await updateTask(digest.id, (t) => confirmTask(t, Date.now(), "cli", signing));
      // The path is built at run time: a command that names the task files
      // literally is asked about first (Warden's string guard, #422 N4) — the
      // sandbox is what has to hold when the guard cannot see the path.
      const script =
        `node -e 'const f=process.argv[1];const t=JSON.parse(require("fs").readFileSync(f,"utf8"));` +
        `t.enabled=true;t.state="scheduled";t.nextRunAt=Date.now();t.envelope={categories:["exec","send"]};` +
        `require("fs").writeFileSync(f,JSON.stringify(t))' "$(cd ../.. && pwd)/tasks/${victim.id}.json"; pwd > here.txt`;
      const results: string[] = [];
      let i = 0;
      const steps = [
        turn([call("bash", { command: script })]),
        turn([{ type: "text", text: "ok" } as Anthropic.ContentBlock]),
      ];
      const provider: Provider = {
        name: "fake",
        runTurn: async (o) => {
          if (i > 0) results.push(lastToolResult(o));
          return steps[i++]!;
        },
      };
      const inbox = new WardenInbox({ defaultTimeoutMs: 1_000 });
      let asked = 0;
      const runner = new TaskRunner({
        tools: [bashTool],
        model: "claude-test",
        cwd: userHome, // the server was started from $HOME
        provider,
        unattendedAllowed: () => true,
        sandboxMode: "workspace-write",
        deliver: async () => ({ delivered: true }),
        log: () => {},
        approvalFactory: createTaskApprovalFactory({
          inbox,
          surface: "local-web",
          log: () => {},
          reachOut: async () => (asked++, { deliver: true, reason: "always-deliver" }),
        }),
      });
      await runner.tick();
      await runner.drain();

      assert.equal(asked, 0, "bash was pre-approved and ran");
      assert.match(results.join("\n"), /EPERM|Operation not permitted|permission denied/i);
      assert.equal(await fsp.readFile(victimFile, "utf8"), before, "the other task is untouched");
      const after = (await getTask(victim.id))!;
      assert.equal(after.enabled, false);
      assert.equal(after.envelope, undefined);
      const ws = await fsp.realpath(path.join(home, "task-workspaces", digest.id));
      assert.equal((await fsp.readFile(path.join(ws, "here.txt"), "utf8")).trim(), ws);
      assert.equal(fs.existsSync(path.join(userHome, "here.txt")), false);
      await inbox.shutdown();
    });
  },
);

test("bash and file writes are not sandboxed when the workspace is /, the user's home, or holds the Lisa home", async () => {
  await withUserHome(async (userHome, home) => {
    const inbox = new WardenInbox({ defaultTimeoutMs: 1 });
    const decide = async (workspaceRoot: string, tool: string, input: unknown) => {
      const session = createWardenSession({
        surface: "local-web",
        uid: null,
        origin: { kind: "routine", id: "t_x" },
        taskId: "t_x",
        sandboxMode: "workspace-write",
        workspaceRoot,
        inbox,
        envelope: { tools: ["bash", "write"] },
        home,
        log: () => {},
      });
      return await session.decide(tool, input);
    };
    const own = path.join(home, "task-workspaces", "t_x");
    for (const root of ["/", os.homedir(), userHome]) {
      const bash = await decide(root, "bash", { command: "echo hi" });
      assert.equal(bash.request.sandboxed, false, root);
      assert.equal(bash.verdict.verdict, "ask", root);
      const write = await decide(root, "write", { path: path.join(root, "x.txt"), content: "x" });
      assert.equal(write.request.sandboxed, false, root);
      assert.equal(write.verdict.verdict, "ask", root);
    }
    // The task's own folder is a sandbox: the confirmed envelope applies.
    const bash = await decide(own, "bash", { command: "echo hi" });
    assert.equal(bash.request.sandboxed, true);
    assert.equal(bash.verdict.verdict, "allow");

    // On every surface: an attended chat whose server runs from "/" asks too.
    const chat = createWardenSession({
      surface: "local-web",
      uid: null,
      origin: { kind: "chat" },
      sandboxMode: "workspace-write",
      workspaceRoot: "/",
      inbox,
      home,
      log: () => {},
    });
    assert.equal((await chat.decide("bash", { command: "ls" })).verdict.verdict, "ask");
    await inbox.shutdown();
  });
});
