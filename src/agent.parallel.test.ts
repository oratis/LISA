/**
 * `parallelTools`: the calls of one model turn that are `concurrencySafe`
 * overlap instead of queueing. These tests pin what overlaps, and — more
 * importantly — everything that must look exactly as it does from a serial
 * run: result order, the start/end event sequence, hook order, and the cases
 * where nothing overlaps at all.
 *
 * Overlap is measured by counting calls in flight, not by timing, so the
 * tests cannot flake on a loaded machine.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type RunAgentOptions } from "./agent.js";
import type { Provider, ProviderResult } from "./providers/types.js";
import type { AgentEvent, StoredMessage, ToolDefinition } from "./types.js";

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** One model turn that asks for `calls`, then a final text turn. */
function providerAsking(calls: Array<{ name: string; id: string; input?: object }>): Provider {
  let turn = 0;
  return {
    name: "fake",
    async runTurn(): Promise<ProviderResult> {
      turn++;
      if (turn > 1) {
        return {
          content: [{ type: "text", text: "done", citations: null }],
          stopReason: "end_turn",
          usage: USAGE,
        };
      }
      return {
        content: calls.map(
          (c) =>
            ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.input ?? {},
            }) as Anthropic.ToolUseBlock,
        ),
        stopReason: "tool_use",
        usage: USAGE,
      };
    },
  };
}

/** Tools whose calls only finish when the test says so. */
function harness() {
  let inFlight = 0;
  let peak = 0;
  const log: string[] = [];
  const waiting = new Map<string, () => void>();
  const make = (name: string, concurrencySafe: boolean): ToolDefinition => ({
    name,
    description: "test tool",
    inputSchema: { type: "object" as const },
    ...(concurrencySafe ? { concurrencySafe: true } : {}),
    async execute(input) {
      const tag = String((input as { tag?: string }).tag ?? name);
      inFlight++;
      peak = Math.max(peak, inFlight);
      log.push(`run:${tag}`);
      await new Promise<void>((resolve) => waiting.set(tag, resolve));
      inFlight--;
      log.push(`ran:${tag}`);
      if ((input as { fail?: boolean }).fail) throw new Error(`${tag} failed`);
      return `result of ${tag}`;
    },
  });
  /** Let `tag` finish as soon as it has started. */
  const release = async (tag: string): Promise<void> => {
    for (let i = 0; i < 1_000 && !waiting.has(tag); i++) await new Promise((r) => setImmediate(r));
    const done = waiting.get(tag);
    assert.ok(done, `${tag} never started`);
    waiting.delete(tag);
    done();
  };
  return {
    read: make("lookup", true),
    write: make("mutate", false),
    log,
    release,
    peak: () => peak,
    started: (tag: string) => waiting.has(tag),
  };
}

function run(
  provider: Provider,
  tools: ToolDefinition[],
  extra: Partial<RunAgentOptions> = {},
): { done: Promise<Awaited<ReturnType<typeof runAgent>>>; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const done = runAgent({
    provider,
    systemPrompt: "sys",
    tools,
    toolCtx: { cwd: "/", signal: new AbortController().signal, log: () => {} },
    history: [],
    userMessage: "go",
    model: "claude-sonnet-4-6",
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { done, events };
}

/** The tool_result blocks of the run, in the order the model receives them. */
function results(history: StoredMessage[]): Array<{ id: string; content: string; error: boolean }> {
  const message = history.find(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_result"),
  );
  assert.ok(message && Array.isArray(message.content));
  return message.content.flatMap((b) =>
    b.type === "tool_result"
      ? [{ id: b.tool_use_id, content: String(b.content), error: b.is_error === true }]
      : [],
  );
}

const toolEvents = (events: AgentEvent[]): string[] =>
  events.flatMap((e) =>
    e.type === "tool_call_start"
      ? [`start:${(e.toolInput as { tag?: string }).tag}`]
      : e.type === "tool_call_end"
        ? [`end${e.isError ? "!" : ""}`]
        : [],
  );

const three = [
  { name: "lookup", id: "a", input: { tag: "a" } },
  { name: "lookup", id: "b", input: { tag: "b" } },
  { name: "lookup", id: "c", input: { tag: "c" } },
];

describe("parallelTools", () => {
  test("concurrency-safe calls of one turn overlap; results and events keep call order", async () => {
    const h = harness();
    const { done, events } = run(providerAsking(three), [h.read], { parallelTools: true });
    // Finish them in REVERSE order: c first, a last.
    await h.release("c");
    await h.release("b");
    await h.release("a");
    const result = await done;

    assert.equal(h.peak(), 3, "all three were in flight together");
    assert.deepEqual(h.log.slice(0, 3), ["run:a", "run:b", "run:c"]);
    // The provider requires results in the order of the calls, whatever order
    // they finished in.
    assert.deepEqual(
      results(result.history).map((r) => [r.id, r.content]),
      [
        ["a", "result of a"],
        ["b", "result of b"],
        ["c", "result of c"],
      ],
    );
    // And every consumer of the event stream pairs a start with the NEXT end:
    // the sequence is the serial one, one call at a time.
    assert.deepEqual(toolEvents(events), ["start:a", "end", "start:b", "end", "start:c", "end"]);
  });

  test("off by default: the same turn runs strictly one call at a time", async () => {
    const h = harness();
    const { done, events } = run(providerAsking(three), [h.read]);
    for (const tag of ["a", "b", "c"]) await h.release(tag);
    await done;
    assert.equal(h.peak(), 1);
    assert.deepEqual(h.log, ["run:a", "ran:a", "run:b", "ran:b", "run:c", "ran:c"]);
    assert.deepEqual(toolEvents(events), ["start:a", "end", "start:b", "end", "start:c", "end"]);
  });

  test("a call that is not concurrency-safe waits for everything before it and runs alone", async () => {
    const h = harness();
    const calls = [
      { name: "lookup", id: "a", input: { tag: "a" } },
      { name: "lookup", id: "b", input: { tag: "b" } },
      { name: "mutate", id: "w", input: { tag: "w" } },
      { name: "lookup", id: "c", input: { tag: "c" } },
    ];
    const { done } = run(providerAsking(calls), [h.read, h.write], { parallelTools: true });
    await h.release("b");
    // a is still running: the write must not have started, nor anything after it.
    await new Promise((r) => setImmediate(r));
    assert.equal(h.started("w"), false);
    assert.equal(h.started("c"), false);
    await h.release("a");
    await h.release("w");
    await h.release("c");
    const result = await done;

    assert.equal(h.peak(), 2, "only the two reads before the write overlapped");
    const order = h.log.join(" ");
    assert.ok(order.indexOf("ran:a") < order.indexOf("run:w"), order);
    assert.ok(order.indexOf("ran:b") < order.indexOf("run:w"), order);
    assert.ok(order.indexOf("ran:w") < order.indexOf("run:c"), order);
    assert.deepEqual(
      results(result.history).map((r) => r.id),
      ["a", "b", "w", "c"],
    );
  });

  test("an approval callback keeps the whole turn serial", async () => {
    // A person answering a prompt, or Warden deciding with the taint of the
    // calls before it, needs the calls one at a time.
    const h = harness();
    const asked: string[] = [];
    const { done } = run(providerAsking(three), [h.read], {
      parallelTools: true,
      approval: async (_name, input) => {
        asked.push(String((input as { tag: string }).tag));
        return { allow: true };
      },
    });
    for (const tag of ["a", "b", "c"]) await h.release(tag);
    await done;
    assert.equal(h.peak(), 1);
    assert.deepEqual(asked, ["a", "b", "c"]);
    assert.deepEqual(h.log, ["run:a", "ran:a", "run:b", "ran:b", "run:c", "ran:c"]);
  });

  test("a run under a USD cost cap stays serial: sub-agents share one budget", async () => {
    const h = harness();
    const { done } = run(providerAsking(three), [h.read], {
      parallelTools: true,
      costCapMicroUSD: 50_000_000,
    });
    for (const tag of ["a", "b", "c"]) await h.release(tag);
    await done;
    assert.equal(h.peak(), 1);
  });

  test("a failure, a blocked call and an unregistered tool keep their place in the results", async () => {
    const h = harness();
    const calls = [
      { name: "lookup", id: "a", input: { tag: "a", fail: true } },
      { name: "lookup", id: "b", input: { tag: "b" } },
      { name: "nope", id: "x", input: { tag: "x" } },
      { name: "lookup", id: "c", input: { tag: "c" } },
    ];
    const seen: string[] = [];
    const { done, events } = run(providerAsking(calls), [h.read], {
      parallelTools: true,
      preToolHook: async (_name, input) => {
        const tag = String((input as { tag: string }).tag);
        seen.push(`pre:${tag}`);
        return tag === "b" ? { block: "not this one" } : undefined;
      },
      postToolHook: async (_name, input, _result, isError) => {
        seen.push(`post:${(input as { tag: string }).tag}${isError ? "!" : ""}`);
        return undefined;
      },
    });
    await h.release("a");
    await h.release("c");
    const result = await done;

    assert.deepEqual(results(result.history), [
      { id: "a", content: "a failed", error: true },
      { id: "b", content: "[hook blocked] not this one", error: true },
      { id: "x", content: 'tool "nope" is not registered', error: true },
      { id: "c", content: "result of c", error: false },
    ]);
    assert.deepEqual(toolEvents(events), [
      "start:a",
      "end!",
      "start:b",
      "end!",
      "start:x",
      "end!",
      "start:c",
      "end",
    ]);
    // Hooks fire in call order; a blocked call never executes, so it has no
    // post hook, and neither does a tool that does not exist.
    assert.deepEqual(seen, ["pre:a", "pre:b", "post:a!", "pre:c", "post:c"]);
    assert.equal(h.log.includes("run:b"), false);
  });

  test("no more than eight calls are in flight at once", async () => {
    const h = harness();
    const many = Array.from({ length: 11 }, (_, i) => ({
      name: "lookup",
      id: `t${i}`,
      input: { tag: `t${i}` },
    }));
    const { done } = run(providerAsking(many), [h.read], { parallelTools: true });
    for (const c of many) await h.release(c.id);
    const result = await done;
    assert.equal(h.peak(), 8);
    assert.deepEqual(
      results(result.history).map((r) => r.id),
      many.map((c) => c.id),
    );
  });
});
