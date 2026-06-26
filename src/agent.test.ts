import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.js";
import type {
  Provider,
  ProviderResult,
  ProviderRunOpts,
} from "./providers/types.js";
import type {
  AgentEvent,
  StoredMessage,
  ToolContext,
  ToolDefinition,
} from "./types.js";

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: null } as Anthropic.TextBlock;
}

function toolUseBlock(id: string): Anthropic.ContentBlock {
  return { type: "tool_use", id, name: "echo", input: {} } as Anthropic.ToolUseBlock;
}

/**
 * Fake provider that replays a fixed sequence of turns. If the agent loop
 * asks for more turns than scripted, the last one repeats (handy for
 * "always wants another tool call" scenarios). Records every runTurn opts.
 */
function makeFakeProvider(turns: ProviderResult[]): {
  provider: Provider;
  calls: ProviderRunOpts[];
} {
  const calls: ProviderRunOpts[] = [];
  return {
    calls,
    provider: {
      name: "fake",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        calls.push(opts);
        const turn = turns[Math.min(calls.length - 1, turns.length - 1)]!;
        // tool_use ids must be unique per turn or pairing checks get murky.
        if (turn.stopReason === "tool_use") {
          return {
            ...turn,
            content: [toolUseBlock(`tu_${calls.length}`)],
          };
        }
        return turn;
      },
    },
  };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "test tool",
  inputSchema: { type: "object" as const },
  execute: async () => "ok",
};

function makeToolCtx(signal?: AbortSignal): ToolContext {
  return {
    cwd: "/tmp",
    signal: signal ?? new AbortController().signal,
    log: () => {},
  };
}

describe("runAgent — maxIterations truncation (stopReason=max_iterations)", () => {
  test("hitting the cap mid-tool-loop reports max_iterations and emits an info event", async () => {
    const { provider } = makeFakeProvider([
      { content: [toolUseBlock("tu_0")], stopReason: "tool_use", usage: ZERO_USAGE },
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: "fake-model",
      maxIterations: 3,
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.iterations, 3);
    assert.equal(result.stopReason, "max_iterations");
    const info = events.filter(
      (e) => e.type === "info" && e.message?.includes("max_iterations"),
    );
    assert.equal(info.length, 1, "expected exactly one max_iterations info event");
    assert.match(info[0]!.message!, /3 iterations/);
  });

  test("a run that finishes normally keeps the provider stop reason", async () => {
    const { provider } = makeFakeProvider([
      { content: [toolUseBlock("tu_0")], stopReason: "tool_use", usage: ZERO_USAGE },
      { content: [textBlock("done")], stopReason: "end_turn", usage: ZERO_USAGE },
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: "fake-model",
      maxIterations: 3,
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.finalText, "done");
    assert.equal(
      events.some((e) => e.message?.includes("max_iterations")),
      false,
      "no truncation event for a normal finish",
    );
  });

  test("finishing exactly on the last allowed iteration is not flagged as truncated", async () => {
    const { provider } = makeFakeProvider([
      { content: [toolUseBlock("tu_0")], stopReason: "tool_use", usage: ZERO_USAGE },
      { content: [textBlock("done")], stopReason: "end_turn", usage: ZERO_USAGE },
    ]);

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: "fake-model",
      maxIterations: 2,
      onEvent: () => {},
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.stopReason, "end_turn");
  });
});

describe("runAgent — empty assistant content is filtered from history", () => {
  test("an empty-content turn is neither pushed to history nor persisted", async () => {
    const { provider } = makeFakeProvider([
      { content: [], stopReason: "end_turn", usage: ZERO_USAGE },
    ]);
    const persisted: StoredMessage[] = [];

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "hi",
      model: "fake-model",
      onMessagePersist: (m) => {
        persisted.push(m);
      },
    });

    // Only the user message survives — no assistant message with content: [].
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0]!.role, "user");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.role, "user");
    const emptyAssistants = result.history.filter(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.length === 0,
    );
    assert.equal(emptyAssistants.length, 0);
  });

  test("tool_use/tool_result pairing stays intact when a later turn is empty", async () => {
    const { provider } = makeFakeProvider([
      { content: [toolUseBlock("tu_0")], stopReason: "tool_use", usage: ZERO_USAGE },
      { content: [], stopReason: "end_turn", usage: ZERO_USAGE },
    ]);
    const persisted: StoredMessage[] = [];

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "hi",
      model: "fake-model",
      onMessagePersist: (m) => {
        persisted.push(m);
      },
    });

    // user, assistant(tool_use), user(tool_result) — and nothing after.
    assert.deepEqual(
      result.history.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    const assistant = result.history[1]!;
    assert.ok(Array.isArray(assistant.content));
    const toolUse = (assistant.content as Anthropic.ContentBlock[]).find(
      (b) => b.type === "tool_use",
    ) as Anthropic.ToolUseBlock;
    const toolResult = (result.history[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, toolUse.id);
    // Persisted stream mirrors history (no empty assistant message).
    assert.deepEqual(
      persisted.map((m) => m.role),
      ["user", "assistant", "user"],
    );
  });

  test("non-empty assistant content is still pushed and persisted", async () => {
    const { provider } = makeFakeProvider([
      { content: [textBlock("hello")], stopReason: "end_turn", usage: ZERO_USAGE },
    ]);
    const persisted: StoredMessage[] = [];

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "hi",
      model: "fake-model",
      onMessagePersist: (m) => {
        persisted.push(m);
      },
    });

    assert.deepEqual(
      result.history.map((m) => m.role),
      ["user", "assistant"],
    );
    assert.equal(persisted.length, 2);
    assert.equal(result.finalText, "hello");
  });
});

describe("runAgent — failed first turn defers user-message persistence", () => {
  test("nothing is persisted when the first provider call throws", async () => {
    const provider: Provider = {
      name: "fake",
      async runTurn(): Promise<ProviderResult> {
        throw new Error("request ended without sending any chunks");
      },
    };
    const persisted: StoredMessage[] = [];
    const events: AgentEvent[] = [];

    await assert.rejects(
      runAgent({
        provider,
        systemPrompt: "sys",
        tools: [],
        toolCtx: makeToolCtx(),
        history: [],
        userMessage: "hi",
        model: "fake-model",
        onMessagePersist: (m) => {
          persisted.push(m);
        },
        onEvent: (e) => events.push(e),
      }),
      /any chunks/,
    );

    // No orphaned user message in the session file → retrying the same message
    // won't duplicate the user turn.
    assert.equal(persisted.length, 0);
    // The failure is still surfaced as an error event for the UI.
    assert.ok(events.some((e) => e.type === "error"));
  });
});

describe("runAgent — abort signal plumbing", () => {
  test("toolCtx.signal is forwarded to provider.runTurn opts", async () => {
    const { provider, calls } = makeFakeProvider([
      { content: [textBlock("ok")], stopReason: "end_turn", usage: ZERO_USAGE },
    ]);
    const ac = new AbortController();

    await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [],
      toolCtx: makeToolCtx(ac.signal),
      history: [],
      userMessage: "hi",
      model: "fake-model",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.signal, ac.signal);
  });

  test("a provider throw (e.g. SDK abort error) emits an error event and rethrows", async () => {
    const boom = new Error("Request was aborted.");
    const provider: Provider = {
      name: "fake",
      async runTurn() {
        throw boom;
      },
    };
    const events: AgentEvent[] = [];

    await assert.rejects(
      runAgent({
        provider,
        systemPrompt: "sys",
        tools: [],
        toolCtx: makeToolCtx(),
        history: [],
        userMessage: "hi",
        model: "fake-model",
        onEvent: (e) => events.push(e),
      }),
      boom,
    );
    assert.ok(
      events.some((e) => e.type === "error" && e.message === boom.message),
      "error event should carry the thrown message",
    );
  });
});

describe("runAgent — token budget circuit-breaker (stopReason=budget_exceeded)", () => {
  const USAGE_200 = { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };

  test("stops at the turn boundary once cumulative tokens reach budgetTokens", async () => {
    // Each tool_use turn spends 200 tokens. With a 300 budget: after turn 1
    // (200) the loop continues, turn 2 pushes the total to 400, and the breaker
    // fires at the next turn boundary — before a 3rd provider call.
    const { provider, calls } = makeFakeProvider([
      { content: [toolUseBlock("tu")], stopReason: "tool_use", usage: USAGE_200 },
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: "fake-model",
      maxIterations: 32,
      budgetTokens: 300,
      onEvent: (e) => events.push(e),
    });

    assert.equal(result.stopReason, "budget_exceeded");
    assert.equal(result.iterations, 2);
    assert.equal(calls.length, 2, "should stop before a third provider call");
    assert.equal(result.inputTokens + result.outputTokens, 400);
    const info = events.filter(
      (e) => e.type === "info" && e.message?.includes("budget_exceeded"),
    );
    assert.equal(info.length, 1, "expected one budget_exceeded info event");
  });

  test("no budgetTokens → runs to maxIterations unchanged", async () => {
    const { provider, calls } = makeFakeProvider([
      { content: [toolUseBlock("tu")], stopReason: "tool_use", usage: USAGE_200 },
    ]);
    const result = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: "fake-model",
      maxIterations: 3,
    });
    assert.equal(result.stopReason, "max_iterations");
    assert.equal(calls.length, 3);
  });
});
