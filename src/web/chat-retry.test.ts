/**
 * Retrying a chat turn that a disconnect cut short (#491): the retry continues
 * that turn instead of adding the same message to the conversation again, and
 * a disconnect still aborts the turn, which Pocket Stop relies on.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider, ProviderResult, ProviderRunOpts } from "../providers/types.js";
import type { StoredMessage } from "../types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-chat-retry-"));
process.env.LISA_HOME = TMP;
process.env.CLAUDE_HOME = path.join(TMP, "claude");
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_MAIL_POLL_MINUTES = "0";
process.env.LISA_LOG_FORMAT = "text";
for (const k of [
  "LISA_EDITION",
  "LISA_WEB_TOKEN",
  "LISA_LOG_FILE",
  "K_SERVICE",
  "LISA_MODEL_FALLBACK",
  "LISA_MANAGED_SESSION",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
]) {
  delete process.env[k];
}

const { startWebServer } = await import("./server.js");
const { unfinishedTurnIndex, closeInterruptedToolCalls } = await import("./chat-retry.js");

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
type Step = (opts: ProviderRunOpts) => Promise<ProviderResult>;
let steps: Step[] = [];
const calls: StoredMessage[][] = [];
let abortedCalls = 0;
const provider: Provider = {
  name: "fixture",
  runTurn(opts) {
    calls.push(structuredClone(opts.messages));
    const step = steps.shift();
    if (!step) return Promise.reject(new Error("no scripted step left"));
    return step(opts);
  },
};
const reply =
  (text: string): Step =>
  (opts) => {
    opts.handlers?.onTextDelta?.(text);
    return Promise.resolve({
      content: [{ type: "text", text }],
      stopReason: "end_turn",
      usage,
    } as unknown as ProviderResult);
  };
const callTool =
  (id: string): Step =>
  () =>
    Promise.resolve({
      content: [{ type: "tool_use", id, name: "lookup", input: {} }],
      stopReason: "tool_use",
      usage,
    } as unknown as ProviderResult);
/** A model call that only ends when the turn is aborted. */
const hangUntilAborted: Step = (opts) =>
  new Promise((_, reject) => {
    const fail = () => {
      abortedCalls++;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (opts.signal?.aborted) fail();
    else opts.signal?.addEventListener("abort", fail, { once: true });
  });

let server: http.Server;
let port: number;

before(async () => {
  server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [
      {
        name: "lookup",
        description: "look something up",
        inputSchema: { type: "object" as const },
        execute: () => Promise.resolve("found"),
      },
    ],
    model: "claude-sonnet-4-6",
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
    provider,
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(TMP, { recursive: true, force: true });
});

type ChatEvent = Record<string, unknown>;

/** POST /chat and collect its events; with `cutAfter`, hang up once that event arrives. */
function chat(message: string, cutAfter?: string): Promise<ChatEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ChatEvent[] = [];
    let buffer = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(events);
      }
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/chat",
        method: "POST",
        headers: { "content-type": "application/json" },
        agent: false,
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let at = buffer.indexOf("\n\n");
          while (at >= 0 && !done) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf("\n\n");
            if (!frame.startsWith("data: ")) continue;
            const event = JSON.parse(frame.slice("data: ".length)) as ChatEvent;
            events.push(event);
            if (cutAfter && event.type === cutAfter) {
              req.destroy();
              finish();
            }
          }
        });
        res.on("end", finish);
        res.on("error", finish);
      },
    );
    req.on("error", (err) => (cutAfter ? finish() : reject(err)));
    req.end(JSON.stringify({ message }));
  });
}

async function history(): Promise<StoredMessage[]> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/api/history", agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve((JSON.parse(body) as { messages: StoredMessage[] }).messages));
      })
      .on("error", reject);
  });
}

function typed(message: StoredMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  const first = message.content[0];
  return first?.type === "text" ? first.text : null;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition timed out");
}

describe("retrying a chat turn cut off by a disconnect (#491)", () => {
  test("the retry continues the turn and the message appears once", async () => {
    steps = [callTool("t1"), hangUntilAborted, reply("Sunny all day.")];
    calls.length = 0;
    abortedCalls = 0;
    const cut = await chat("weather please", "tool_end");
    assert.ok(cut.some((e) => e.type === "tool_end"));
    // The disconnect still aborts the turn (Stop relies on it).
    await until(() => abortedCalls === 1);

    const retried = await chat("weather please");
    assert.ok(
      retried.some((e) => e.type === "text" && e.text === "Sunny all day."),
      JSON.stringify(retried),
    );
    assert.ok(!retried.some((e) => e.type === "error"), JSON.stringify(retried));

    // The model saw the message once, followed by the tool exchange it had
    // already made, and carried on from there.
    const resumed = calls[calls.length - 1]!;
    assert.equal(resumed.filter((m) => typed(m) === "weather please").length, 1);
    assert.deepEqual(
      resumed.slice(-3).map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(typed(resumed[resumed.length - 3]!), "weather please");

    // So does the history the app shows.
    const shown = await history();
    assert.equal(shown.filter((m) => typed(m) === "weather please").length, 1);
    const last = shown[shown.length - 1]!;
    assert.equal(last.role, "assistant");
    assert.match(JSON.stringify(last.content), /Sunny all day\./);
  });

  test("the same words after a reply are a new turn", async () => {
    steps = [reply("Hi!"), reply("Hi again!")];
    await chat("hello there");
    await chat("hello there");
    const shown = await history();
    assert.equal(shown.filter((m) => typed(m) === "hello there").length, 2);
  });

  test("a different message after a cut-off turn is appended normally", async () => {
    steps = [callTool("t2"), hangUntilAborted, reply("Done.")];
    abortedCalls = 0;
    await chat("first question", "tool_end");
    await until(() => abortedCalls === 1);
    await chat("second question");
    const shown = await history();
    assert.equal(shown.filter((m) => typed(m) === "first question").length, 1);
    assert.equal(shown.filter((m) => typed(m) === "second question").length, 1);
  });
});

describe("chat-retry helpers", () => {
  const user = (text: string, extra = 0): StoredMessage => ({
    role: "user",
    content: [
      { type: "text", text },
      ...Array.from({ length: extra }, () => ({ type: "text" as const, text: "[file]" })),
    ],
  });
  const toolUse = (id: string): StoredMessage => ({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "lookup", input: {} }],
  });
  const toolResult = (id: string): StoredMessage => ({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "found" }],
  });
  const answer: StoredMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };

  test("finds the unanswered last message, and nothing else", () => {
    const cut = [answer, user("a"), toolUse("t"), toolResult("t")];
    assert.equal(unfinishedTurnIndex(cut, "a", 0), 1);
    assert.equal(unfinishedTurnIndex(cut, "b", 0), -1);
    assert.equal(unfinishedTurnIndex(cut, "a", 1), -1, "different attachments");
    assert.equal(unfinishedTurnIndex([...cut, answer], "a", 0), -1, "answered");
    assert.equal(unfinishedTurnIndex([user("a", 2)], "a", 2), 0);
    assert.equal(unfinishedTurnIndex([{ role: "user", content: "a" }], "a", 0), 0);
    assert.equal(unfinishedTurnIndex([], "a", 0), -1);
  });

  test("closes tool calls left without results", () => {
    const both: StoredMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "x", name: "lookup", input: {} },
        { type: "tool_use", id: "y", name: "lookup", input: {} },
      ],
    };
    const closing = closeInterruptedToolCalls([user("a"), both]);
    assert.ok(closing);
    assert.equal(closing.role, "user");
    const results = closing.content as Array<{ tool_use_id: string; is_error?: boolean }>;
    assert.deepEqual(
      results.map((r) => [r.tool_use_id, r.is_error]),
      [
        ["x", true],
        ["y", true],
      ],
    );
    assert.equal(closeInterruptedToolCalls([user("a"), toolUse("t"), toolResult("t")]), null);
    assert.equal(closeInterruptedToolCalls([user("a"), answer]), null);
    assert.equal(closeInterruptedToolCalls([]), null);
  });
});
