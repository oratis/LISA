import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runSubagent, type SubagentOptions } from "./subagent.js";
import type { Provider, ProviderResult, ProviderUsage } from "./providers/types.js";
import type { ToolDefinition } from "./types.js";

let idN = 0;
function usage(o: Partial<ProviderUsage> = {}): ProviderUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...o };
}
function textTurn(text: string, u: Partial<ProviderUsage> = {}): ProviderResult {
  return { content: [{ type: "text", text } as Anthropic.ContentBlock], stopReason: "end_turn", usage: usage(u) };
}
function toolTurn(name: string, u: Partial<ProviderUsage> = {}): ProviderResult {
  return {
    content: [{ type: "tool_use", id: `t${++idN}`, name, input: {} } as Anthropic.ContentBlock],
    stopReason: "tool_use",
    usage: usage(u),
  };
}
function scripted(queue: ProviderResult[], tail?: ProviderResult): Provider {
  let i = 0;
  return { name: "fake", async runTurn() { return i < queue.length ? queue[i++]! : tail ?? (() => { throw new Error("drained"); })(); } };
}
const echoTool: ToolDefinition = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" } as Anthropic.Tool.InputSchema,
  execute: async () => "ok",
};
function opts(over: Partial<SubagentOptions>): SubagentOptions {
  return {
    prompt: "do it",
    systemPrompt: "sys",
    tools: [echoTool],
    cwd: "/tmp",
    signal: new AbortController().signal,
    model: "test-model",
    ...over,
  };
}

describe("runSubagent", () => {
  test("returns the final text and maps token usage + stopReason", async () => {
    const provider = scripted([textTurn("the answer", { inputTokens: 10, outputTokens: 4 })]);
    const r = await runSubagent(opts({ provider }));
    assert.equal(r.text, "the answer");
    assert.equal(r.inputTokens, 10);
    assert.equal(r.outputTokens, 4);
    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.toolCallCount, 0);
  });

  test("counts tool calls across turns", async () => {
    const provider = scripted([toolTurn("echo"), toolTurn("echo"), textTurn("done")]);
    const r = await runSubagent(opts({ provider }));
    assert.equal(r.toolCallCount, 2);
    assert.equal(r.stopReason, "end_turn");
  });

  test("surfaces truncation via stopReason (budget breaker)", async () => {
    const provider = scripted([], toolTurn("echo", { inputTokens: 100, outputTokens: 100 }));
    const r = await runSubagent(opts({ provider, budgetTokens: 150 }));
    assert.equal(r.stopReason, "budget_exceeded");
  });

  test("surfaces truncation via stopReason (max_iterations)", async () => {
    const provider = scripted([], toolTurn("echo"));
    // maxIterations is fixed at 32 inside runSubagent; a tail that always wants a
    // tool eventually hits it. Keep the assertion to the observable contract.
    const r = await runSubagent(opts({ provider }));
    assert.equal(r.stopReason, "max_iterations");
    assert.equal(r.toolCallCount, 32);
  });
});
