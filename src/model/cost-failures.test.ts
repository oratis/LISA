/**
 * #407 review R2: a capped call that spends and then throws used to be charged
 * nothing — a fallback link that fails after output, a failed child subagent,
 * a stream retry — and a run could reach ~28× its cap. Each is now counted at
 * what the call was admitted with, so a run ends at or under its cap plus the
 * prompt-estimate error.
 *
 * "True spend" below is what each fake provider would really have been billed:
 * the prompt at four bytes a token plus the provider's framing, and the whole
 * output ceiling it was given, at the price table's face rates.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../agent.js";
import { costMicroUSD } from "../billing/prices.js";
import { FallbackProvider } from "../providers/fallback.js";
import { streamRetryOpts, withStreamRetry } from "../providers/stream-retry.js";
import {
  failedWithoutSpend,
  notSent,
  type Provider,
  type ProviderResult,
  type ProviderRunOpts,
  type ProviderUsage,
} from "../providers/types.js";
import { createTaskTool } from "../tools/task.js";
import type { ToolContext, ToolDefinition } from "../types.js";
import { RunCostCap } from "./cost.js";

const echo: ToolDefinition = {
  name: "echo",
  description: "test tool",
  inputSchema: { type: "object" as const },
  execute: async () => "ok",
};

const ctx = (): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  log: () => {},
});

let id = 0;
const toolUse = (name = "echo", input: unknown = {}): Anthropic.ContentBlock =>
  ({ type: "tool_use", id: `tu_${++id}`, name, input }) as Anthropic.ToolUseBlock;

/** The provider's real bill for one call: prompt at 4 B/token + framing, output = its ceiling. */
function billOf(opts: ProviderRunOpts, outputTokens = opts.maxTokens ?? 16_000): ProviderUsage {
  const bytes =
    Buffer.byteLength(opts.systemPrompt) +
    Buffer.byteLength(
      JSON.stringify(
        opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      ),
    ) +
    Buffer.byteLength(JSON.stringify(opts.messages));
  return {
    inputTokens: Math.ceil(bytes / 4) + 400,
    outputTokens: Math.min(outputTokens, opts.maxTokens ?? outputTokens),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = original;
  });
}

describe("a capped call that spends and then throws is counted", () => {
  test("a fallback link that fails after output: counted, and the next link is tried only if it still fits", async () => {
    for (const { cap, maxTokens } of [
      { cap: 100_000, maxTokens: 16_000 },
      { cap: 2_000_000, maxTokens: 2_000 },
    ]) {
      let truth = 0;
      let opusCalls = 0;
      const opus: Provider = {
        name: "opus",
        async runTurn(o) {
          opusCalls++;
          truth += costMicroUSD(o.model, billOf(o)); // spent prompt + full output…
          throw new Error("stream terminated after output"); // …then failed
        },
      };
      const flash: Provider = {
        name: "flash",
        async runTurn(o): Promise<ProviderResult> {
          const usage = billOf(o, 50);
          truth += costMicroUSD(o.model, usage);
          return { content: [toolUse()], stopReason: "tool_use", usage };
        },
      };
      const chain = new FallbackProvider([
        { model: "claude-opus-4-1", provider: opus },
        { model: "gemini-2.5-flash", provider: flash },
      ]);
      const outcome = await quietly(() =>
        runAgent({
          provider: chain,
          systemPrompt: "sys",
          tools: [echo],
          toolCtx: ctx(),
          history: [],
          userMessage: "go",
          model: "claude-opus-4-1",
          maxTokens,
          maxIterations: 64,
          costCapMicroUSD: cap,
        }).then(
          (r) => r.stopReason,
          (err: Error) => `threw: ${err.message}`,
        ),
      );
      assert.ok(
        truth <= cap,
        `cap ${cap}: true spend ${truth} (${(truth / cap).toFixed(2)}×) over ${opusCalls} failed links`,
      );
      if (cap === 100_000) {
        // The first failed link used up what the cap could pay; no second link was tried.
        assert.equal(outcome, "threw: stream terminated after output");
        assert.equal(opusCalls, 1);
      } else {
        // With room to spare the chain still falls back; the run ends at its
        // cap — stopped before a call, or by a failed call nothing could follow.
        assert.ok(opusCalls >= 2, `${opusCalls} failed links`);
        assert.match(outcome, /^(budget_exceeded|threw: stream terminated after output)$/);
      }
    }
  });

  test("a child subagent that spends and then fails: the parent's cap counts it", async () => {
    let truth = 0;
    let childCalls = 0;
    const child: Provider = {
      name: "child",
      async runTurn(o) {
        childCalls++;
        truth += costMicroUSD(o.model, billOf(o));
        throw new Error("stream terminated after output");
      },
    };
    const parent: Provider = {
      name: "parent",
      async runTurn(o): Promise<ProviderResult> {
        const usage = billOf(o, 30);
        truth += costMicroUSD(o.model, usage);
        // The model re-delegates every turn.
        return {
          content: [
            toolUse("task", { description: "retry it", prompt: "do", model: "claude-opus-4-1" }),
          ],
          stopReason: "tool_use",
          usage,
        };
      },
    };
    const task = createTaskTool({
      fullToolset: () => [echo],
      readOnlyToolset: () => [echo],
      cwd: "/tmp",
      signal: new AbortController().signal,
      defaultModel: "claude-opus-4-1",
      providerFor: () => child,
    });
    const cap = 100_000;
    const heard: number[] = [];
    const result = await runAgent({
      provider: parent,
      systemPrompt: "sys",
      tools: [echo, task],
      toolCtx: ctx(),
      history: [],
      userMessage: "go",
      model: "gemini-2.5-flash",
      maxIterations: 32,
      costCapMicroUSD: cap,
      onCostCharged: (m) => heard.push(m),
    });
    assert.equal(result.stopReason, "budget_exceeded");
    assert.ok(
      truth <= cap,
      `true spend ${truth} (${(truth / cap).toFixed(2)}×) over ${childCalls} child calls`,
    );
    assert.ok(childCalls <= 2, `the parent stopped delegating (${childCalls} child calls)`);
    assert.ok(heard.reduce((a, b) => a + b, 0) >= truth, "counted at least what was spent");
  });

  test("stream retries: each failed attempt is counted, and one more is made only if it still fits", async () => {
    for (const { cap, maxTokens } of [
      { cap: 50_000, maxTokens: 16_000 },
      { cap: 2_000_000, maxTokens: 2_000 },
    ]) {
      let truth = 0;
      let attempts = 0;
      const flaky: Provider = {
        name: "flaky",
        async runTurn(o): Promise<ProviderResult> {
          return await withStreamRetry({ ...streamRetryOpts(o), baseDelayMs: 0 }, async () => {
            attempts++;
            truth += costMicroUSD(o.model, billOf(o));
            // Every other attempt dies before a delta reached the caller.
            if (attempts % 2 === 1) throw new Error("terminated");
            return { content: [toolUse()], stopReason: "tool_use", usage: billOf(o) };
          });
        },
      };
      const outcome = await runAgent({
        provider: flaky,
        systemPrompt: "sys",
        tools: [echo],
        toolCtx: ctx(),
        history: [],
        userMessage: "go",
        model: "claude-sonnet-4-6",
        maxTokens,
        maxIterations: 64,
        costCapMicroUSD: cap,
      }).then(
        (r) => r.stopReason,
        (err: Error) => `threw: ${err.message}`,
      );
      assert.ok(
        truth <= cap,
        `cap ${cap}: true spend ${truth} (${(truth / cap).toFixed(2)}×) in ${attempts} attempts`,
      );
      if (cap === 50_000) {
        assert.equal(outcome, "threw: terminated", "no retry the cap could not pay for");
        assert.equal(attempts, 1);
      } else {
        assert.ok(attempts >= 4, `with room to spare, retries still happen (${attempts})`);
        assert.match(outcome, /^(budget_exceeded|threw: terminated)$/);
      }
    }
  });

  test("a call that failed without spending is not counted", async () => {
    for (const error of [
      Object.assign(new Error("rate limited"), { status: 429 }),
      Object.assign(new Error("overloaded"), { status: 529 }),
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      notSent(new Error("refused before sending")),
    ]) {
      const heard: number[] = [];
      await assert.rejects(
        runAgent({
          provider: {
            name: "refuses",
            async runTurn() {
              throw error;
            },
          },
          systemPrompt: "sys",
          tools: [echo],
          toolCtx: ctx(),
          history: [],
          userMessage: "go",
          model: "claude-sonnet-4-6",
          costCapMicroUSD: 1_000_000,
          onCostCharged: (m) => heard.push(m),
        }),
      );
      assert.deepEqual(heard, [], `${error.message}: nothing counted`);
    }
  });

  test("what may have spent: everything else", () => {
    for (const error of [
      new Error("terminated"),
      Object.assign(new Error("bad gateway"), { status: 502 }),
      Object.assign(new Error("gateway timeout"), { status: 504 }),
      Object.assign(new Error("server error"), { status: 500 }),
      Object.assign(new Error("reset"), { cause: { code: "ECONNRESET" } }),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      "a string",
      null,
    ]) {
      assert.equal(failedWithoutSpend(error), false, String((error as Error)?.message ?? error));
    }
  });
});

describe("RunCostCap — failed attempts", () => {
  test("a failed attempt counts the reservation and keeps the admission; a refused retry ends it", () => {
    const heard: number[] = [];
    const cap = new RunCostCap(100_000, "claude-sonnet-4-6", (m) => heard.push(m));
    const verdict = cap.admit({ prompt: ["x".repeat(3_000)], maxTokens: 1_000 });
    assert.equal(verdict.proceed, true);
    let counted = 0;
    let more = true;
    while (more) {
      more = cap.failedAttempt();
      counted += 1;
      assert.equal(heard.length, counted, "each failed attempt is counted once");
      const one = heard[0]!;
      assert.ok(one > 0);
      // Another attempt is allowed exactly while one more worst case fits.
      assert.equal(more, 100_000 - counted * one >= one);
    }
    assert.ok(counted >= 2, `${counted} attempts`);
    cap.chargeFailed(); // the call then throws: already counted, not again
    assert.equal(heard.length, counted);
    assert.ok(cap.spentMicroUSD <= 100_000);
  });

  test("chargeFailed counts once; release counts nothing", () => {
    const heard: number[] = [];
    const cap = new RunCostCap(1_000_000, "claude-sonnet-4-6", (m) => heard.push(m));
    cap.admit({ prompt: ["hello"], maxTokens: 1_000 });
    cap.chargeFailed();
    cap.chargeFailed();
    assert.equal(heard.length, 1);
    cap.admit({ prompt: ["hello"], maxTokens: 1_000 });
    cap.release();
    cap.chargeFailed();
    assert.equal(heard.length, 1);
  });
});
