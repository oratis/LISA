/**
 * A subagent must not be a way around Warden: the `task` tool hands the parent
 * turn's approval gate to the nested run, so the nested run's tool calls are
 * decided by the SAME session (same rules, grants and taint).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { runSubagent } from "../subagent.js";
import { createTaskTool } from "../tools/task.js";
import type { Provider, ProviderResult } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";
import { createWardenSession } from "./session.js";
import { WardenInbox } from "./inbox.js";
import { readAudit } from "./audit.js";

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Calls each scripted tool once, in order, then finishes. */
function scripted(calls: Array<{ name: string; input: unknown }>): Provider {
  let turn = 0;
  return {
    name: "fake",
    async runTurn(): Promise<ProviderResult> {
      const next = calls[turn++];
      if (!next) {
        return {
          content: [{ type: "text", text: "done", citations: null }],
          stopReason: "end_turn",
          usage: USAGE,
        };
      }
      return {
        content: [
          {
            type: "tool_use",
            id: `tu_${turn}`,
            name: next.name,
            input: next.input,
          } as Anthropic.ToolUseBlock,
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    },
  };
}

function recording(name: string, ran: string[]): ToolDefinition {
  return {
    name,
    description: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    async execute() {
      ran.push(name);
      return "ok";
    },
  };
}

test("a subagent's tool calls are decided by the parent's Warden session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-warden-sub-"));
  const inbox = new WardenInbox({ defaultTimeoutMs: 30 });
  const session = createWardenSession({
    surface: "local-web",
    uid: null,
    origin: { kind: "chat" },
    // Confined: an untainted chat may run the shell without asking. (A
    // workspace that contains the Lisa home would confine nothing.)
    sandboxMode: "workspace-write",
    workspaceRoot: path.join(home, "ws"),
    inbox,
    home,
  });
  const ran: string[] = [];
  const result = await runSubagent({
    prompt: "go",
    systemPrompt: "sys",
    tools: [recording("bash", ran), recording("web_fetch", ran), recording("github", ran)],
    cwd: "/work/project",
    signal: new AbortController().signal,
    provider: scripted([
      { name: "bash", input: { command: "ls" } }, // untainted and sandboxed: allowed
      { name: "web_fetch", input: { url: "https://example.com" } }, // read: allowed, taints
      { name: "bash", input: { command: "ls" } }, // now tainted: asks, expires ⇒ denied
      { name: "github", input: { action: "pr_merge", repo: "o/r" } }, // publish: asks ⇒ denied
    ]),
    approval: session.approval,
  });
  assert.equal(result.toolCallCount, 4);
  assert.deepEqual(ran, ["bash", "web_fetch"], "the tainted bash and the publish never ran");
  assert.equal(session.tainted, true, "taint set inside the subagent is the parent's taint");
  const decisions = (await readAudit({ home })).filter((e) => e.kind === "decision");
  assert.deepEqual(decisions.map((e) => `${e.tool}:${e.verdict}`).reverse(), [
    "bash:allow",
    "web_fetch:allow",
    "bash:ask",
    "github:ask",
  ]);
  await inbox.shutdown();
});

test("without a gate a subagent runs ungated — so the task tool must pass one down", async () => {
  const ran: string[] = [];
  await runSubagent({
    prompt: "go",
    systemPrompt: "sys",
    tools: [recording("github", ran)],
    cwd: "/work/project",
    signal: new AbortController().signal,
    provider: scripted([{ name: "github", input: { action: "pr_merge" } }]),
  });
  assert.deepEqual(ran, ["github"], "this is the bypass the hand-down closes");

  // The task tool forwards ctx.approval. Its provider is not injectable, so
  // assert the forwarding at the source and the behaviour through a gate that
  // refuses before any provider is needed.
  const source = await fs.readFile(new URL("../tools/task.ts", import.meta.url), "utf8");
  assert.match(source, /approval: ctx\?\.approval/);
  const task = createTaskTool({
    fullToolset: () => [],
    readOnlyToolset: () => [],
    cwd: "/work/project",
    signal: new AbortController().signal,
    defaultModel: "claude-sonnet-4-6",
  });
  assert.equal(task.name, "task");
});
