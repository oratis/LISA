/**
 * The Task Engine wired to Warden: unattended runs under a real Warden session
 * and a real approval inbox, with a scripted model and stub tools. Temp homes
 * only — nothing here touches ~/.lisa, the Keychain or a real model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// The operator home is a temp dir, never ~/.lisa. (Every read of LISA_HOME is
// lazy — paths.ts — so setting it here covers everything below.)
process.env.LISA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-task-warden-global-"));
process.env.LISA_SECRETS_BACKEND = "file";

import { homeScope } from "../paths.js";
import type { Provider, ProviderResult, ProviderRunOpts } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";
import { TaskRunner, type TaskRunnerOptions } from "../tasks/runner.js";
import { createTask, type NewTask } from "../tasks/store.js";
import type { Task, TaskNotice } from "../tasks/types.js";
import { readAudit } from "./audit.js";
import { WardenInbox } from "./inbox.js";
import { createTaskApprovalFactory } from "./task-approval.js";

// ── harness ──

async function withHome<T>(fn: (home: string, ws: string) => Promise<T>): Promise<T> {
  const home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-task-warden-")));
  const ws = path.join(home, "ws");
  await fsp.mkdir(ws);
  try {
    return await homeScope.run(home, () => fn(home, ws));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

let idN = 0;
const text = (t: string): Anthropic.ContentBlock =>
  ({ type: "text", text: t }) as Anthropic.ContentBlock;
const call = (name: string, input: unknown = {}): Anthropic.ContentBlock =>
  ({ type: "tool_use", id: `tu_${++idN}`, name, input }) as Anthropic.ContentBlock;
function turn(content: Anthropic.ContentBlock[], tokens = 10): ProviderResult {
  return {
    content,
    stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}
const say = (t: string) => turn([text(t)]);

type Step = ProviderResult | ((o: ProviderRunOpts) => Promise<ProviderResult> | ProviderResult);

function scripted(steps: Step[]) {
  const calls: ProviderRunOpts[] = [];
  const provider: Provider = {
    name: "fake",
    async runTurn(o) {
      calls.push({ ...o, messages: [...o.messages] });
      const step = steps[calls.length - 1];
      if (!step) throw new Error(`scripted provider exhausted at call ${calls.length}`);
      return typeof step === "function" ? await step(o) : step;
    },
  };
  return { provider, calls };
}

function tool(
  name: string,
  execute: ToolDefinition["execute"] = async () => `${name} ok`,
): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object" }, execute };
}

function collector() {
  const notices: TaskNotice[] = [];
  const deliver = async (n: TaskNotice) => {
    notices.push(n);
    return { delivered: true };
  };
  return { notices, deliver };
}

const NOW = Date.parse("2026-10-09T08:00:00Z");

function makeRunner(
  ws: string,
  over: Partial<TaskRunnerOptions> & { provider: Provider },
): TaskRunner {
  return new TaskRunner({
    tools: [],
    model: "claude-test",
    cwd: ws,
    unattendedAllowed: () => true,
    log: () => {},
    now: () => NOW,
    ...over,
  });
}

/** An enabled routine that is due at NOW. */
async function dueRoutine(over: Partial<NewTask> = {}): Promise<Task> {
  return await createTask(
    {
      kind: "routine",
      title: "Morning notes",
      instruction: "Write today's notes to out.txt.",
      origin: { kind: "api" },
      schedule: { expr: "daily:08:00", tz: "UTC" },
      enabled: true,
      state: "scheduled",
      nextRunAt: NOW,
      ...over,
    },
    NOW - 1000,
  );
}

// ── item 1: the factory ──

test("in Warden mode a routine's calls are decided as origin routine, with its task id", async () => {
  await withHome(async (home, ws) => {
    const task = await dueRoutine();
    const inbox = new WardenInbox({ defaultTimeoutMs: 5_000 });
    const { provider } = scripted([
      turn([call("read", { path: path.join(ws, "notes.md") })]),
      say("Nothing new."),
    ]);
    const { deliver } = collector();
    const runner = makeRunner(ws, {
      provider,
      deliver,
      tools: [tool("read")],
      approvalFactory: createTaskApprovalFactory({ inbox, surface: "local-web", log: () => {} }),
    });
    await runner.tick();
    await runner.drain();

    const decisions = (await readAudit({ home })).filter((e) => e.kind === "decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.tool, "read");
    assert.equal(decisions[0]!.verdict, "allow");
    assert.equal(decisions[0]!.origin, "routine");
    assert.equal(decisions[0]!.originId, task.id);
    assert.equal(decisions[0]!.taskId, task.id);
    await inbox.shutdown();
  });
});
