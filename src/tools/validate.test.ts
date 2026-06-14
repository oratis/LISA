import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { validateToolInput } from "./validate.js";
import { runAgent } from "../agent.js";
import type { Provider, ProviderResult } from "../providers/types.js";
import type { ToolContext, ToolDefinition } from "../types.js";

function schema(o: object): Anthropic.Tool.InputSchema {
  return { type: "object", ...o } as Anthropic.Tool.InputSchema;
}

describe("validateToolInput (pure)", () => {
  test("non-object input is rejected", () => {
    assert.equal(validateToolInput(schema({}), "str").ok, false);
    assert.equal(validateToolInput(schema({}), 42).ok, false);
    assert.equal(validateToolInput(schema({}), null).ok, false);
    assert.equal(validateToolInput(schema({}), []).ok, false);
  });

  test("empty schema accepts any object", () => {
    assert.equal(validateToolInput(schema({}), { anything: 1 }).ok, true);
  });

  test("missing required field → error naming it", () => {
    const r = validateToolInput(schema({ required: ["slug"], properties: { slug: { type: "string" } } }), {});
    assert.equal(r.ok, false);
    assert.match(r.error!, /slug/);
  });

  test("present required field → ok", () => {
    const r = validateToolInput(schema({ required: ["slug"], properties: { slug: { type: "string" } } }), { slug: "a" });
    assert.equal(r.ok, true);
  });

  test("primitive type mismatch → error; match → ok", () => {
    assert.equal(validateToolInput(schema({ properties: { n: { type: "number" } } }), { n: "x" }).ok, false);
    assert.equal(validateToolInput(schema({ properties: { n: { type: "number" } } }), { n: 5 }).ok, true);
    assert.equal(validateToolInput(schema({ properties: { b: { type: "boolean" } } }), { b: true }).ok, true);
  });

  test("integer rejects a float", () => {
    assert.equal(validateToolInput(schema({ properties: { n: { type: "integer" } } }), { n: 5 }).ok, true);
    assert.equal(validateToolInput(schema({ properties: { n: { type: "integer" } } }), { n: 5.5 }).ok, false);
  });

  test("enum membership is enforced", () => {
    const s = schema({ properties: { action: { type: "string", enum: ["discover", "call"] } } });
    assert.equal(validateToolInput(s, { action: "call" }).ok, true);
    const bad = validateToolInput(s, { action: "nope" });
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /discover, call/);
  });

  test("permissive where it should be: optional-absent ok, unknown type ok, extra props ok", () => {
    assert.equal(validateToolInput(schema({ properties: { opt: { type: "string" } } }), {}).ok, true);
    assert.equal(validateToolInput(schema({ properties: { x: { type: "weird" } } }), { x: 1 }).ok, true);
    assert.equal(validateToolInput(schema({ properties: { a: { type: "string" } } }), { a: "x", extra: 9 }).ok, true);
  });
});

describe("validateToolInput — agent-loop integration (fail-closed)", () => {
  test("a malformed tool call is rejected before execute, with a paired is_error", async () => {
    let ran = false;
    let id = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const queue: ProviderResult[] = [
      {
        content: [{ type: "tool_use", id: `v${++id}`, name: "needsSlug", input: {} } as Anthropic.ContentBlock],
        stopReason: "tool_use",
        usage,
      },
      { content: [{ type: "text", text: "ok" } as Anthropic.ContentBlock], stopReason: "end_turn", usage },
    ];
    let i = 0;
    const provider: Provider = { name: "fake", async runTurn() { return queue[i++]!; } };
    const tool: ToolDefinition = {
      name: "needsSlug",
      description: "requires slug",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } } as Anthropic.Tool.InputSchema,
      async execute() { ran = true; return "ran"; },
    };
    const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal, log: () => {} };
    const r = await runAgent({
      provider, systemPrompt: "s", tools: [tool], toolCtx: ctx, history: [], userMessage: "go", model: "m",
    });
    assert.equal(ran, false, "malformed input must not reach execute()");
    const res = (r.history.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Anthropic.ContentBlockParam[])
      .find((b) => b.type === "tool_result") as Anthropic.ToolResultBlockParam;
    assert.equal(res.is_error, true);
    assert.match(String(res.content), /invalid input/);
    assert.equal(r.stopReason, "end_turn", "loop recovers after the rejected call");
  });
});
