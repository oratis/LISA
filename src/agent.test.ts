import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type RunAgentOptions } from "./agent.js";
import type { Provider, ProviderResult, ProviderRunOpts } from "./providers/types.js";
import type { AgentEvent, StoredMessage, ToolContext, ToolDefinition } from "./types.js";

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: null };
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
    const info = events.filter((e) => e.type === "info" && e.message?.includes("max_iterations"));
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
      (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0,
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
  const USAGE_200 = {
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

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
    const info = events.filter((e) => e.type === "info" && e.message?.includes("budget_exceeded"));
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

describe("runAgent — per-run USD cap (costCapMicroUSD)", () => {
  // gemini-2.5-flash at face value: input $0.42/M, output $3.50/M.
  const MODEL = "gemini-2.5-flash";
  // One tool_use turn that costs 10k × 0.42 + 2k × 3.5 = 4_200 + 7_000 = 11_200 micro-USD.
  const TURN = {
    inputTokens: 10_000,
    outputTokens: 2_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  /**
   * A provider that always wants another tool call, bills 10k prompt tokens
   * per request, and — like the real ones — never emits more output than the
   * `maxTokens` it was given.
   */
  function loopingProvider(): { provider: Provider; calls: ProviderRunOpts[] } {
    const calls: ProviderRunOpts[] = [];
    return {
      calls,
      provider: {
        name: "fake",
        async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
          calls.push(opts);
          return {
            content: [toolUseBlock(`tu_${calls.length}`)],
            stopReason: "tool_use",
            usage: {
              ...TURN,
              outputTokens: Math.min(TURN.outputTokens, opts.maxTokens ?? TURN.outputTokens),
            },
          };
        },
      },
    };
  }

  const faceCost = (r: { inputTokens: number; outputTokens: number }): number =>
    Math.ceil((r.inputTokens * 420_000 + r.outputTokens * 3_500_000) / 1_000_000);

  function run(costCapMicroUSD: number | undefined, extra: Partial<RunAgentOptions> = {}) {
    const { provider, calls } = loopingProvider();
    const events: AgentEvent[] = [];
    const result = runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: MODEL,
      maxIterations: 32,
      costCapMicroUSD,
      onEvent: (e) => events.push(e),
      ...extra,
    });
    return { result, calls, events };
  }

  test("stops a looping run deterministically, and the run ends under its cap", async () => {
    // $0.03 cap, 11_200 per full turn. Turns 1 and 2 spend 22_400. Before turn
    // 3 the loop reserves the 10k-token prompt (4_200) and has 3_400 left for
    // output, so it admits the call with the output ceiling cut to 971 tokens.
    // Before turn 4 not even the prompt fits: stop.
    const { result, calls, events } = run(30_000);
    const r = await result;
    assert.equal(r.stopReason, "budget_exceeded");
    assert.equal(calls.length, 3);
    assert.equal(r.iterations, 3);
    // First call: almost the whole cap is available for output (the prompt is
    // a few dozen bytes), which is still under the default 16k ceiling.
    assert.ok(calls[0]!.maxTokens! > 8_000 && calls[0]!.maxTokens! < 8_572);
    assert.deepEqual(
      calls.slice(1).map((c) => c.maxTokens),
      [4_171, 971],
    );
    assert.equal(faceCost(r), 29_999);
    assert.ok(faceCost(r) <= 30_000, "the run must end under its cap");
    const info = events.filter((e) => e.type === "info" && e.message?.includes("cost cap"));
    assert.equal(info.length, 1);
    assert.match(info[0]!.type === "info" ? info[0]!.message : "", /stopReason=budget_exceeded/);
  });

  test("is deterministic: the same run stops at the same place every time", async () => {
    const counts = [];
    for (let i = 0; i < 3; i++) {
      const { result, calls } = run(30_000);
      await result;
      counts.push(calls.length);
    }
    assert.deepEqual(counts, [3, 3, 3]);
  });

  test("never crosses the cap, across a range of caps", async () => {
    // A provider whose billed prompt tracks the request it was sent (4 bytes
    // per token), so the pre-call reservation is exercised honestly: 40 KB of
    // history is about 10k prompt tokens on the first call and grows from there.
    const history: StoredMessage[] = [
      { role: "user", content: "x".repeat(40_000) },
      { role: "assistant", content: [textBlock("noted")] },
    ];
    for (const cap of [100, 5_000, 11_200, 20_000, 33_600, 100_000, 1_000_000]) {
      const calls: ProviderRunOpts[] = [];
      const provider: Provider = {
        name: "fake",
        async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
          calls.push(opts);
          const bytes =
            Buffer.byteLength(opts.systemPrompt) + Buffer.byteLength(JSON.stringify(opts.messages));
          return {
            content: [toolUseBlock(`tu_${calls.length}`)],
            stopReason: "tool_use",
            usage: {
              inputTokens: Math.ceil(bytes / 4),
              outputTokens: Math.min(2_000, opts.maxTokens ?? 2_000),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        },
      };
      const r = await runAgent({
        provider,
        systemPrompt: "sys",
        tools: [echoTool],
        toolCtx: makeToolCtx(),
        history,
        userMessage: "go",
        model: MODEL,
        maxIterations: 500,
        costCapMicroUSD: cap,
      });
      assert.equal(r.stopReason, "budget_exceeded", `cap ${cap}`);
      assert.ok(faceCost(r) <= cap, `cap ${cap}: spent ${faceCost(r)} over ${calls.length} calls`);
      if (cap >= 100_000) assert.ok(calls.length >= 2, `cap ${cap} should allow real work`);
    }
  });

  test("clamps the output ceiling handed to the provider to what the cap still buys", async () => {
    // $0.012 cap on a tiny prompt: ~3.4k output tokens are affordable, well
    // under the default 16k ceiling.
    const { result, calls } = run(12_000);
    await result;
    assert.equal(calls.length, 1);
    const ceiling = calls[0]!.maxTokens;
    assert.ok(ceiling !== undefined && ceiling < 16_000, `ceiling ${ceiling} was not clamped`);
    // The admitted call's worst case (its real prompt is far below the
    // reservation) fits under the cap.
    assert.ok((ceiling * 3_500_000) / 1_000_000 <= 12_000);
  });

  test("a generous cap leaves the caller's own output ceiling alone", async () => {
    const { result, calls } = run(50_000_000, { maxIterations: 1 });
    await result;
    assert.equal(calls[0]!.maxTokens, 16_000);
  });

  test("a cap too small for any useful turn makes no provider call at all", async () => {
    const { result, calls } = run(100);
    const r = await result;
    assert.equal(calls.length, 0);
    assert.equal(r.iterations, 0);
    assert.equal(r.stopReason, "budget_exceeded");
    assert.equal(r.inputTokens + r.outputTokens, 0);
  });

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number]) {
    test(`fails closed: a cap of ${String(bad)} never calls the model`, async () => {
      const { result, calls, events } = run(bad);
      const r = await result;
      assert.equal(calls.length, 0);
      assert.equal(r.stopReason, "budget_exceeded");
      assert.ok(
        events.some((e) => e.type === "info" && /refusing to run uncapped/.test(e.message ?? "")),
      );
    });
  }

  test("provider usage that cannot be read stops the run instead of counting as free", async () => {
    const { provider, calls } = makeFakeProvider([
      {
        content: [toolUseBlock("tu")],
        stopReason: "tool_use",
        usage: { ...TURN, outputTokens: Number.NaN },
      },
    ]);
    const r = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: MODEL,
      costCapMicroUSD: 50_000_000,
    });
    assert.equal(calls.length, 1, "must stop at the first boundary after the unreadable usage");
    assert.equal(r.stopReason, "budget_exceeded");
  });

  test("a provider that answers but reports zero usage still exhausts the cap", async () => {
    // An OpenAI-compatible endpoint that ignores include_usage. Counting its
    // zeros as free let a $0.05 run reach 31× its cap; each call is now charged
    // what it was admitted with, so even a provider that really did spend its
    // whole output ceiling every time stays under the cap.
    const calls: ProviderRunOpts[] = [];
    let trueSpend = 0;
    const provider: Provider = {
      name: "fake",
      async runTurn(opts: ProviderRunOpts): Promise<ProviderResult> {
        calls.push(opts);
        const bytes =
          Buffer.byteLength(opts.systemPrompt) + Buffer.byteLength(JSON.stringify(opts.messages));
        trueSpend += Math.ceil(
          (Math.ceil(bytes / 4) * 3_500_000 + (opts.maxTokens ?? 16_000) * 14_000_000) / 1_000_000,
        );
        return {
          content: [toolUseBlock(`tu_${calls.length}`)],
          stopReason: "tool_use",
          usage: ZERO_USAGE,
        };
      },
    };
    const r = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: "gpt-4o",
      maxIterations: 32,
      costCapMicroUSD: 50_000,
    });
    assert.equal(r.stopReason, "budget_exceeded");
    assert.ok(calls.length < 32, `${calls.length} calls`);
    assert.ok(trueSpend <= 50_000, `true spend ${trueSpend} over ${calls.length} calls`);
  });

  test("a large transcript is counted before it is sent", async () => {
    // ~300 KB of history reserves ~100k prompt tokens = 42_000 micro-USD,
    // which a $0.03 cap cannot cover: no call is made.
    const history: StoredMessage[] = [
      { role: "user", content: "x".repeat(300_000) },
      { role: "assistant", content: [textBlock("noted")] },
    ];
    const { result, calls } = run(30_000, { history });
    const r = await result;
    assert.equal(calls.length, 0);
    assert.equal(r.stopReason, "budget_exceeded");
  });

  test("no cap → unchanged behaviour", async () => {
    const { result, calls } = run(undefined, { maxIterations: 3 });
    const r = await result;
    assert.equal(r.stopReason, "max_iterations");
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.maxTokens, 16_000);
  });

  test("works together with budgetTokens — whichever trips first stops the run", async () => {
    const { result, calls } = run(50_000_000, { budgetTokens: 12_000 });
    const r = await result;
    assert.equal(calls.length, 1);
    assert.equal(r.stopReason, "budget_exceeded");
  });

  test("a run that finishes under its cap ends normally", async () => {
    const { provider, calls } = makeFakeProvider([
      { content: [textBlock("done")], stopReason: "end_turn", usage: TURN },
    ]);
    const r = await runAgent({
      provider,
      systemPrompt: "sys",
      tools: [echoTool],
      toolCtx: makeToolCtx(),
      history: [],
      userMessage: "go",
      model: MODEL,
      costCapMicroUSD: 1_000_000,
    });
    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.finalText, "done");
    assert.equal(calls.length, 1);
  });
});
