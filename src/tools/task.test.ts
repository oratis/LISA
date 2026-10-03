/**
 * The task tool inside a run with a USD cap: a subagent spends inside the
 * parent's cap, never beside it.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../agent.js";
import { costMicroUSD } from "../billing/prices.js";
import type {
  Provider,
  ProviderResult,
  ProviderRunOpts,
  ProviderUsage,
} from "../providers/types.js";
import type { ToolContext, ToolDefinition } from "../types.js";
import { createTaskTool } from "./task.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "test tool",
  inputSchema: { type: "object" as const },
  execute: async () => "ok",
};

function toolUse(id: string, name: string, input: unknown = {}): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

/** What a call really costs: the prompt at four bytes a token, plus the output it produced. */
function usageOf(opts: ProviderRunOpts, outputTokens: number): ProviderUsage {
  const bytes =
    Buffer.byteLength(opts.systemPrompt) + Buffer.byteLength(JSON.stringify(opts.messages));
  return {
    inputTokens: Math.ceil(bytes / 4) + 50,
    outputTokens: Math.min(outputTokens, opts.maxTokens ?? outputTokens),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** A subagent provider that always wants another tool call and writes long answers. */
function loopingChild(model: string): {
  provider: Provider;
  calls: ProviderRunOpts[];
  spend: () => number;
} {
  const calls: ProviderRunOpts[] = [];
  let spent = 0;
  return {
    calls,
    spend: () => spent,
    provider: {
      name: "child",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        calls.push(opts);
        const usage = usageOf(opts, 16_000);
        spent += costMicroUSD(model, usage);
        return {
          content: [toolUse(`c_${calls.length}`, "echo")],
          stopReason: "tool_use",
          usage,
        };
      },
    },
  };
}

function ctx(costCap?: ToolContext["costCap"]): ToolContext {
  return { cwd: "/tmp", signal: new AbortController().signal, log: () => {}, costCap };
}

function taskTool(provider: Provider) {
  return createTaskTool({
    fullToolset: () => [echoTool],
    readOnlyToolset: () => [echoTool],
    cwd: "/tmp",
    signal: new AbortController().signal,
    defaultModel: "gemini-2.5-flash",
    providerFor: () => provider,
  });
}

const TASK = { description: "dig", prompt: "find it", model: "claude-opus-4-1" };

describe("task tool — subagents spend inside the parent's USD cap", () => {
  test("a capped parent and its opus subagent together stay under the parent's cap", async () => {
    // The probe that found this: parent capped at $0.02 stopped at 0.98× its
    // cap while the subagent it started spent ~290 USD.
    const child = loopingChild("claude-opus-4-1");
    const parentCalls: ProviderRunOpts[] = [];
    let parentSpend = 0;
    const parent: Provider = {
      name: "parent",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        parentCalls.push(opts);
        const usage = usageOf(opts, 300);
        parentSpend += costMicroUSD("gemini-2.5-flash", usage);
        return {
          content: [toolUse(`p_${parentCalls.length}`, "task", TASK)],
          stopReason: "tool_use",
          usage,
        };
      },
    };
    const r = await runAgent({
      provider: parent,
      systemPrompt: "sys",
      tools: [taskTool(child.provider)],
      toolCtx: ctx(),
      history: [],
      userMessage: "go",
      model: "gemini-2.5-flash",
      maxIterations: 32,
      costCapMicroUSD: 20_000,
    });
    assert.equal(r.stopReason, "budget_exceeded");
    assert.ok(child.calls.length >= 1, "the subagent did run");
    const total = parentSpend + child.spend();
    assert.ok(total <= 20_000, `parent ${parentSpend} + subagent ${child.spend()} = ${total}`);
    // The subagent was held to the parent's remaining cap at opus rates.
    assert.ok(child.calls.every((c) => (c.maxTokens ?? 16_000) < 16_000));
  });

  test("a parent whose cap is spent starts no subagent", async () => {
    const child = loopingChild("claude-opus-4-1");
    const charged: number[] = [];
    const out = await taskTool(child.provider).execute(
      TASK,
      ctx({ remainingMicroUSD: () => 0, charge: (m) => charged.push(m) }),
    );
    assert.equal(child.calls.length, 0);
    assert.match(out, /not started: this run's cost cap is spent/);
    assert.deepEqual(charged, []);
  });

  test("a subagent that cannot afford its first call makes none", async () => {
    const child = loopingChild("claude-opus-4-1");
    const charged: number[] = [];
    const out = await taskTool(child.provider).execute(
      TASK,
      ctx({ remainingMicroUSD: () => 500, charge: (m) => charged.push(m) }),
    );
    assert.equal(child.calls.length, 0);
    assert.match(out, /stopped by its budget/);
    assert.deepEqual(charged, []);
  });

  test("a subagent's spend reaches the parent as it is spent, even if it then fails", async () => {
    let n = 0;
    const flaky: Provider = {
      name: "flaky",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        if (++n > 2) throw new Error("upstream reset");
        return {
          content: [toolUse(`c_${n}`, "echo")],
          stopReason: "tool_use",
          usage: usageOf(opts, 100),
        };
      },
    };
    const charged: number[] = [];
    await assert.rejects(
      taskTool(flaky).execute(
        TASK,
        ctx({ remainingMicroUSD: () => 5_000_000, charge: (m) => charged.push(m) }),
      ),
      /upstream reset/,
    );
    assert.equal(charged.length, 2);
    assert.ok(charged.every((m) => m > 0));
  });

  test("without a cap the subagent runs as before", async () => {
    const calls: ProviderRunOpts[] = [];
    const once: Provider = {
      name: "once",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        calls.push(opts);
        return {
          content: [{ type: "text", text: "found", citations: null }],
          stopReason: "end_turn",
          usage: usageOf(opts, 10),
        };
      },
    };
    const out = await taskTool(once).execute(TASK, ctx());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.maxTokens, 16_000);
    assert.match(out, /found/);
  });
});
