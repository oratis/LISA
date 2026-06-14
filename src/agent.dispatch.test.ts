import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type RunAgentOptions } from "./agent.js";
import type { Provider, ProviderResult, ProviderRunOpts, ProviderUsage } from "./providers/types.js";
import type { ToolContext, ToolDefinition, StoredMessage } from "./types.js";

// Complements agent.test.ts (which covers stop conditions / empty-content /
// abort) with the TOOL-DISPATCH path: execute → result, unregistered/throwing
// tools, multi-tool turns, and the approval + hook gates. These need a provider
// that can emit arbitrary/multiple tool_use blocks, so it returns each scripted
// ProviderResult verbatim rather than synthesizing a single echo call.

let idN = 0;
function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text } as Anthropic.ContentBlock;
}
function toolUseBlock(name: string, input: unknown = {}): Anthropic.ContentBlock {
  return { type: "tool_use", id: `tu_${++idN}`, name, input } as Anthropic.ContentBlock;
}
function usage(o: Partial<ProviderUsage> = {}): ProviderUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...o };
}
function turn(content: Anthropic.ContentBlock[], stopReason: string): ProviderResult {
  return { content, stopReason, usage: usage() };
}

/** Replays scripted turns verbatim; repeats `tail` once the queue drains. */
function scriptedProvider(queue: ProviderResult[], tail?: ProviderResult): Provider {
  let i = 0;
  return {
    name: "fake",
    async runTurn(_opts: ProviderRunOpts): Promise<ProviderResult> {
      if (i < queue.length) return queue[i++]!;
      if (tail) return tail;
      throw new Error("scriptedProvider queue exhausted");
    },
  };
}

function ctx(): ToolContext {
  return { cwd: "/tmp", signal: new AbortController().signal, log: () => {} };
}

function echoTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "echo",
    description: "echo the input back",
    inputSchema: { type: "object" } as Anthropic.Tool.InputSchema,
    async execute(input) {
      return "echoed:" + JSON.stringify(input);
    },
    ...over,
  } as ToolDefinition;
}

function baseOpts(over: Partial<RunAgentOptions>): RunAgentOptions {
  return {
    provider: scriptedProvider([turn([textBlock("hi")], "end_turn")]),
    systemPrompt: "sys",
    tools: [echoTool()],
    toolCtx: ctx(),
    history: [],
    userMessage: "do it",
    model: "test-model",
    ...over,
  };
}

/** All tool_use ids (assistant) and tool_result ids (user) across history. */
function pairing(history: StoredMessage[]): { uses: string[]; results: string[] } {
  const uses: string[] = [];
  const results: string[] = [];
  for (const m of history) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Anthropic.ContentBlockParam[]) {
      if (b.type === "tool_use") uses.push(b.id);
      if (b.type === "tool_result") results.push(b.tool_use_id);
    }
  }
  return { uses, results };
}

function allResults(history: StoredMessage[]): Anthropic.ToolResultBlockParam[] {
  return (history.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Anthropic.ContentBlockParam[])
    .filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}

describe("runAgent — tool dispatch", () => {
  test("executes the tool with the model's input and pairs the result", async () => {
    const seen: unknown[] = [];
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", { x: 1 })], "tool_use"),
      turn([textBlock("done")], "end_turn"),
    ]);
    const r = await runAgent(
      baseOpts({ provider, tools: [echoTool({ async execute(i) { seen.push(i); return "RAN"; } })] }),
    );
    assert.deepEqual(seen, [{ x: 1 }]);
    const { uses, results } = pairing(r.history);
    assert.deepEqual(uses, results);
    assert.equal(allResults(r.history)[0]!.content, "RAN");
    assert.equal(r.stopReason, "end_turn");
  });

  test("renderResultForModel shapes the tool_result content", async () => {
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", {})], "tool_use"),
      turn([textBlock("ok")], "end_turn"),
    ]);
    const r = await runAgent(
      baseOpts({
        provider,
        tools: [echoTool({ async execute() { return { n: 7 }; }, renderResultForModel: (o) => `rendered:${(o as { n: number }).n}` })],
      }),
    );
    assert.equal(allResults(r.history)[0]!.content, "rendered:7");
  });

  test("multiple tool_use in one turn → all paired in a single tool_result message", async () => {
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", { a: 1 }), toolUseBlock("echo", { b: 2 })], "tool_use"),
      turn([textBlock("done")], "end_turn"),
    ]);
    const r = await runAgent(baseOpts({ provider }));
    const { uses, results } = pairing(r.history);
    assert.equal(uses.length, 2);
    assert.deepEqual(new Set(uses), new Set(results));
    const toolMsg = r.history.find(
      (m) => Array.isArray(m.content) && (m.content as Anthropic.ContentBlockParam[]).length > 0 &&
        (m.content as Anthropic.ContentBlockParam[]).every((b) => b.type === "tool_result"),
    );
    assert.equal((toolMsg!.content as Anthropic.ContentBlockParam[]).length, 2);
  });

  test("unregistered tool → paired is_error result, loop recovers", async () => {
    const provider = scriptedProvider([
      turn([toolUseBlock("ghost", {})], "tool_use"),
      turn([textBlock("recovered")], "end_turn"),
    ]);
    const r = await runAgent(baseOpts({ provider }));
    const { uses, results } = pairing(r.history);
    assert.deepEqual(uses, results, "no orphan tool_use");
    assert.equal(allResults(r.history)[0]!.is_error, true);
    assert.equal(r.stopReason, "end_turn");
  });

  test("a throwing tool → paired is_error result carrying the message, loop continues", async () => {
    const provider = scriptedProvider([
      turn([toolUseBlock("boom", {})], "tool_use"),
      turn([textBlock("ok")], "end_turn"),
    ]);
    const r = await runAgent(
      baseOpts({ provider, tools: [echoTool({ name: "boom", async execute() { throw new Error("kaboom"); } })] }),
    );
    const res = allResults(r.history)[0]!;
    assert.equal(res.is_error, true);
    assert.match(String(res.content), /kaboom/);
    assert.equal(r.stopReason, "end_turn");
  });
});

describe("runAgent — approval + hook gating (security-relevant)", () => {
  test("denied tool is NOT executed and yields a paired [denied] error", async () => {
    let ran = false;
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", {})], "tool_use"),
      turn([textBlock("ok")], "end_turn"),
    ]);
    const r = await runAgent(
      baseOpts({
        provider,
        tools: [echoTool({ async execute() { ran = true; return "x"; } })],
        approval: async () => ({ allow: false, reason: "nope" }),
      }),
    );
    assert.equal(ran, false);
    const res = allResults(r.history)[0]!;
    assert.equal(res.is_error, true);
    assert.match(String(res.content), /denied/);
  });

  test("approval allow lets the tool run", async () => {
    let ran = false;
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", {})], "tool_use"),
      turn([textBlock("ok")], "end_turn"),
    ]);
    await runAgent(
      baseOpts({
        provider,
        tools: [echoTool({ async execute() { ran = true; return "x"; } })],
        approval: async () => ({ allow: true }),
      }),
    );
    assert.equal(ran, true);
  });

  test("preToolHook block prevents execution and yields a paired error", async () => {
    let ran = false;
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", {})], "tool_use"),
      turn([textBlock("ok")], "end_turn"),
    ]);
    const r = await runAgent(
      baseOpts({
        provider,
        tools: [echoTool({ async execute() { ran = true; return "x"; } })],
        preToolHook: async () => ({ block: "policy" }),
      }),
    );
    assert.equal(ran, false);
    assert.match(String(allResults(r.history)[0]!.content), /hook blocked/);
  });

  test("postToolHook can rewrite the tool result the model sees", async () => {
    const provider = scriptedProvider([
      turn([toolUseBlock("echo", {})], "tool_use"),
      turn([textBlock("ok")], "end_turn"),
    ]);
    const r = await runAgent(baseOpts({ provider, postToolHook: async () => ({ rewriteResult: "REWRITTEN" }) }));
    assert.equal(allResults(r.history)[0]!.content, "REWRITTEN");
  });
});
