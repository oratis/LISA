import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expressionCatalog, resolveExpression } from "./catalog.js";
import { expressionTurn } from "./turn.js";
import {
  parseExpressionPreferences,
  readExpressionPreferences,
  writeExpressionPreferences,
} from "./preferences.js";
import { homeScope } from "../paths.js";
import { SessionStore } from "../sessions/store.js";

const auto = { display: "auto", frequency: "restrained" } as const;
const ctx = { cwd: "/tmp", signal: new AbortController().signal, log() {} };
const record = {
  version: 1,
  id: "message-1",
  assetId: "sticker-hello",
  format: "animated",
} as const;

test("all 32 conversation assets resolve to bundled, versioned still/animated/native files", async () => {
  assert.equal(expressionCatalog.length, 32);
  assert.equal(new Set(expressionCatalog.map((x) => x.id)).size, 32);
  for (const item of expressionCatalog) {
    const e = resolveExpression({
      ...record,
      assetId: item.id,
      animation: "https://untrusted.example/a.gif",
    })!;
    assert.ok(e.alt && e.emoji && e.durationMs > 0);
    for (const url of [e.animation, e.poster, e.native]) {
      assert.ok(url.startsWith("/assets/visuals/soft-ink-motion-v1/"));
      assert.ok((await fs.stat(new URL("../web" + url, import.meta.url))).size <= 256 * 1024);
    }
  }
  for (const bad of [
    { version: 2 },
    { assetId: "../../secrets" },
    { format: "html" },
    { id: "<img src=x>" },
  ]) {
    assert.equal(resolveExpression({ ...record, ...bad }), undefined);
  }
});

test("turn queue caps one expression, respects spacing, explicit requests, vetoes and settings", async () => {
  const send = (t: ReturnType<typeof expressionTurn>) =>
    t.tool.execute({ assetId: record.assetId, format: "animated" }, ctx);
  for (const distance of [1, 2]) {
    const t = expressionTurn(auto, distance, "hello");
    await send(t);
    assert.equal(t.pending(), undefined);
  }
  for (const [prefs, distance, text, expected] of [
    [auto, 3, "hello", "animated"],
    [auto, 1, "发一个表情包", "animated"],
    [{ ...auto, frequency: "lively" }, 1, "hello", "animated"],
    [{ ...auto, display: "static" }, 3, "hello", "static"],
    [{ ...auto, display: "emoji" }, 3, "hello", "emoji"],
    [{ ...auto, display: "off" }, 3, "发一个表情包", undefined],
    [auto, 3, "不要表情包", undefined],
    [auto, 3, "don't send stickers", undefined],
  ] as const) {
    const t = expressionTurn(prefs, distance, text);
    await send(t);
    assert.equal(t.pending()?.format, expected);
    const first = t.pending();
    await send(t);
    assert.equal(t.pending(), first);
  }
  const t = expressionTurn(auto, Infinity, "hello");
  await assert.rejects(
    t.tool.execute({ assetId: "https://example.com/a.gif", format: "auto" }, ctx),
  );
  assert.equal(t.pending(), undefined);
});

test("the system-prompt suffix depends on saved preferences only, never on cadence or wording", async () => {
  // It is appended to the 1h-cached system prefix and logged as a session
  // `prompt` entry whenever it changes: a per-turn flip re-writes both.
  for (const prefs of [
    auto,
    { ...auto, frequency: "lively" },
    { ...auto, display: "static" },
    { ...auto, display: "off" },
  ] as const) {
    const prompts = new Set(
      [
        [1, "hello"],
        [3, "hello"],
        [Infinity, "发一个表情包"],
        [3, "不要表情包"],
        [2, "don't send stickers"],
      ].map(([distance, text]) => expressionTurn(prefs, distance as number, text as string).prompt),
    );
    assert.equal(prompts.size, 1, `${prefs.display}/${prefs.frequency}`);
  }
  assert.notEqual(
    expressionTurn(auto, 1, "hello").prompt,
    expressionTurn({ ...auto, display: "off" }, 1, "hello").prompt,
  );
  // The per-turn decision is still enforced, and explained, by the tool itself.
  const reasons = await Promise.all(
    [
      expressionTurn(auto, 1, "hello"),
      expressionTurn(auto, 3, "不要表情包"),
      expressionTurn({ ...auto, display: "off" }, 3, "发一个表情包"),
    ].map(async (t) => {
      const result = await t.tool.execute({ assetId: record.assetId, format: "auto" }, ctx);
      assert.equal(t.pending(), undefined);
      return result;
    }),
  );
  assert.match(reasons[0]!, /recent reply/);
  assert.match(reasons[1]!, /asked for no stickers/);
  assert.match(reasons[2]!, /turned conversation expressions off/);
});

test("failed work cannot trigger spontaneous celebration", async () => {
  const t = expressionTurn(auto, Infinity, "finish this task");
  await t.tool.execute({ assetId: "sticker-celebrate", format: "auto" }, ctx);
  t.noteToolFailure();
  assert.equal(t.pending(), undefined);
  const comfort = expressionTurn(auto, Infinity, "help me");
  comfort.noteToolFailure();
  await comfort.tool.execute({ assetId: "apologetic", format: "static" }, ctx);
  assert.equal(comfort.pending()?.assetId, "apologetic");
});

test("preferences are tenant-scoped, validated and fail to stills if damaged", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-expressions-"));
  try {
    const a = path.join(dir, "a"),
      b = path.join(dir, "b");
    await Promise.all([
      homeScope.run(a, () => writeExpressionPreferences({ ...auto, display: "off" })),
      homeScope.run(b, () => writeExpressionPreferences({ ...auto, display: "emoji" })),
    ]);
    assert.equal((await homeScope.run(a, readExpressionPreferences)).display, "off");
    assert.equal((await homeScope.run(b, readExpressionPreferences)).display, "emoji");
    await fs.writeFile(path.join(a, "expression-preferences.json"), "{");
    assert.equal((await homeScope.run(a, readExpressionPreferences)).display, "static");
    assert.throws(() => parseExpressionPreferences({ display: "wat", frequency: "lively" }));
    assert.deepEqual(await homeScope.run(path.join(dir, "new"), readExpressionPreferences), auto);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("history restores metadata, pagination and cadence while model/legacy replay stays plain text", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-expression-history-"));
  try {
    await homeScope.run(dir, async () => {
      const store = await SessionStore.create({ cwd: dir, model: "test" });
      assert.equal(await store.turnsSinceExpression(), Infinity);
      await store.appendMessage({ role: "user", content: "hello" });
      const fallback = await store.appendExpression(record);
      assert.equal(typeof fallback.content, "string");
      await store.appendMessage({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok".repeat(200000) }],
      });
      await store.appendMessage({ role: "user", content: "next turn" });
      const reopened = await SessionStore.open(store.id);
      assert.equal(await reopened.turnsSinceExpression(), 1);
      const page = await reopened.readMessagePage(1, 2, true);
      assert.equal(page.messages[1]?.expression?.assetId, record.assetId);
      assert.ok(
        (await reopened.readMessagePage(0, 20)).messages.every((m) => !("expression" in m)),
      );
      await fs.appendFile(
        store.path,
        JSON.stringify({
          type: "message",
          message: fallback,
          expression: { ...record, version: 999 },
        }) + "\n",
      );
      const unknown = (await reopened.readMessagePage(0, 1, true)).messages[0]!;
      assert.equal(unknown.expression, undefined);
      assert.deepEqual(unknown, fallback);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
