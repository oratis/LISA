import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { ManagedRegistry } from "./managed.js";
import type { Provider, ProviderResult, ProviderUsage } from "../providers/types.js";
import type { ToolDefinition } from "../types.js";

let idN = 0;
function usage(o: Partial<ProviderUsage> = {}): ProviderUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...o };
}
function toolUse(name: string, input: unknown = {}): Anthropic.ContentBlock {
  return { type: "tool_use", id: "t" + ++idN, name, input } as Anthropic.ContentBlock;
}
function text(t: string): Anthropic.ContentBlock {
  return { type: "text", text: t } as Anthropic.ContentBlock;
}
function turn(content: Anthropic.ContentBlock[], stopReason: string): ProviderResult {
  return { content, stopReason, usage: usage() };
}
function scripted(queue: ProviderResult[]): Provider {
  let i = 0;
  return {
    name: "fake",
    async runTurn() {
      if (i < queue.length) return queue[i++]!;
      throw new Error("scripted provider drained");
    },
  };
}
const editTool: ToolDefinition = {
  name: "edit", // in DEFAULT_MUTATING_TOOLS → triggers approval-pause
  description: "edit a file",
  inputSchema: { type: "object" } as Anthropic.Tool.InputSchema,
  async execute() { return "edited"; },
};

function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("waitFor timeout")); }
    }, 10);
  });
}

describe("ManagedAgent — approval-paused tool flow", () => {
  test("pauses on a mutating tool, resumes on approve, records activity", async () => {
    const reg = new ManagedRegistry();
    const v = reg.start({
      task: "fix it",
      cwd: "/tmp/proj",
      systemPrompt: "sys",
      tools: [editTool],
      provider: scripted([
        turn([toolUse("edit", { file_path: "foo.ts" })], "tool_use"),
        turn([text("done")], "end_turn"),
      ]),
    });
    const a = reg.get(v.id)!;

    await waitFor(() => a.view().pending?.tool === "edit");
    assert.equal(a.view().state, "waiting");
    assert.equal(a.view().stateReason, "permission");

    assert.equal(reg.decide(v.id, true), true);
    await waitFor(() => { const x = a.view(); return x.state === "waiting" && !x.pending; });

    const view = a.view();
    assert.ok(view.lastTools.includes("edit"), "tool recorded");
    assert.ok(view.filesTouched.includes("foo.ts"), "file recorded");
    assert.equal(view.lastText, "done");
    assert.ok(view.turnCount >= 1);
    reg.cancel(v.id);
  });

  test("deny lets the agent continue (tool not run)", async () => {
    let ran = false;
    const reg = new ManagedRegistry();
    const v = reg.start({
      task: "x",
      cwd: "/tmp",
      systemPrompt: "sys",
      tools: [{ ...editTool, async execute() { ran = true; return "ran"; } }],
      provider: scripted([turn([toolUse("edit", {})], "tool_use"), turn([text("ok")], "end_turn")]),
    });
    const a = reg.get(v.id)!;
    await waitFor(() => !!a.view().pending);
    reg.decide(v.id, false);
    await waitFor(() => a.view().state === "waiting" && !a.view().pending);
    assert.equal(ran, false, "denied tool must not execute");
    reg.cancel(v.id);
  });
});

describe("ManagedAgent — follow-ups + cancel", () => {
  test("send injects a follow-up that continues the agent", async () => {
    const reg = new ManagedRegistry();
    const v = reg.start({
      task: "first",
      cwd: "/tmp",
      systemPrompt: "sys",
      tools: [],
      provider: scripted([turn([text("first-done")], "end_turn"), turn([text("second-done")], "end_turn")]),
    });
    const a = reg.get(v.id)!;
    await waitFor(() => a.view().state === "waiting" && a.view().lastText === "first-done");
    reg.send(v.id, "now do more");
    await waitFor(() => a.view().lastText === "second-done");
    reg.cancel(v.id);
  });

  test("cancel stops the agent (state done)", async () => {
    const reg = new ManagedRegistry();
    const v = reg.start({
      task: "x",
      cwd: "/tmp",
      systemPrompt: "sys",
      tools: [],
      provider: scripted([turn([text("idle")], "end_turn")]),
    });
    const a = reg.get(v.id)!;
    await waitFor(() => a.view().state === "waiting");
    assert.equal(reg.cancel(v.id), true);
    await waitFor(() => a.view().state === "done");
    reg.cancel(v.id); // idempotent — stays done, no throw
    assert.equal(a.view().state, "done");
  });

  test("send/decide/cancel on an unknown id → false", () => {
    const reg = new ManagedRegistry();
    assert.equal(reg.send("nope", "x"), false);
    assert.equal(reg.decide("nope", true), false);
    assert.equal(reg.cancel("nope"), false);
  });
});
