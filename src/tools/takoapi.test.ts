import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatRegistry,
  extractAgentReply,
  takoDiscover,
  takoCall,
  takoapiTool,
  type TakoFetcher,
} from "./takoapi.js";
import type { ToolContext } from "../types.js";

const CTX = {} as ToolContext; // execute guard paths don't touch ctx

describe("formatRegistry", () => {
  test("lists agents from an {agents:[…]} shape with skills", () => {
    const out = formatRegistry(
      JSON.stringify({
        agents: [
          { name: "Refactor Bot", slug: "refactor-bot", description: "refactors code", skills: ["refactor", { name: "rename" }] },
        ],
      }),
    );
    assert.match(out, /Refactor Bot/);
    assert.match(out, /slug: refactor-bot/);
    assert.match(out, /refactors code/);
    assert.match(out, /refactor, rename/);
  });
  test("accepts a bare array and caps the list at `limit`", () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ name: `a${i}`, slug: `s${i}` }));
    assert.equal(formatRegistry(JSON.stringify(arr), 3).split("\n").length, 3);
  });
  test("empty / malformed → friendly message", () => {
    assert.match(formatRegistry(JSON.stringify({ agents: [] })), /no matching agents/);
    assert.match(formatRegistry("nope"), /could not parse/);
  });
});

describe("extractAgentReply", () => {
  test("OpenAI-shim shape", () => {
    assert.equal(extractAgentReply(JSON.stringify({ choices: [{ message: { content: "hi there" } }] })), "hi there");
  });
  test("A2A message parts", () => {
    assert.equal(
      extractAgentReply(JSON.stringify({ message: { parts: [{ text: "part one" }, { text: "two" }] } })),
      "part one\ntwo",
    );
  });
  test("flat fields (reply/text/result)", () => {
    assert.equal(extractAgentReply(JSON.stringify({ reply: "r" })), "r");
  });
  test("non-JSON → raw passthrough", () => {
    assert.equal(extractAgentReply("plain text reply"), "plain text reply");
  });
});

function fetcher(over: Partial<TakoFetcher> = {}): TakoFetcher {
  return {
    get: async () => ({ ok: true, status: 200, body: JSON.stringify({ agents: [{ name: "A", slug: "a" }] }) }),
    postJson: async () => ({ ok: true, status: 200, body: JSON.stringify({ text: "agent reply" }) }),
    ...over,
  };
}

describe("takoDiscover / takoCall", () => {
  test("discover formats the registry", async () => {
    assert.match(await takoDiscover("refactor", fetcher()), /slug: a/);
  });
  test("discover handles an unreachable registry", async () => {
    assert.match(
      await takoDiscover("x", fetcher({ get: async () => ({ ok: false, status: 0, body: "" }) })),
      /unreachable/,
    );
  });
  test("call returns the agent reply and sends a Bearer key", async () => {
    let seenAuth = "";
    const f = fetcher({
      postJson: async (_u, _b, h) => {
        seenAuth = h.authorization ?? "";
        return { ok: true, status: 200, body: JSON.stringify({ text: "done" }) };
      },
    });
    assert.equal(await takoCall("a", "do it", "sk-tako-x", f), "done");
    assert.equal(seenAuth, "Bearer sk-tako-x");
  });
  test("call surfaces a 401 clearly", async () => {
    assert.match(
      await takoCall("a", "x", "bad", fetcher({ postJson: async () => ({ ok: false, status: 401, body: "" }) })),
      /401/,
    );
  });
});

describe("takoapiTool.execute guards (no network)", () => {
  test("call without slug/text → asks for both", async () => {
    assert.match(await takoapiTool.execute({ action: "call", slug: "a" }, CTX), /needs both/);
  });
  test("call without TAKO_KEY → points to the dashboard", async () => {
    const saved = process.env.TAKO_KEY;
    delete process.env.TAKO_KEY;
    try {
      assert.match(await takoapiTool.execute({ action: "call", slug: "a", text: "x" }, CTX), /TAKO_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.TAKO_KEY = saved;
    }
  });
});
