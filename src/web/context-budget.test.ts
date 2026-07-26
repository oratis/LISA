import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StoredMessage } from "../types.js";
import {
  estimateCurrentWebInputTokens,
  estimateStoredMessageTokens,
  selectWebModelContext,
  webContextBudgetTokens,
} from "./context-budget.js";

const text = (role: "user" | "assistant", value: string): StoredMessage => ({
  role,
  content: [{ type: "text", text: value }],
});

describe("web context budget", () => {
  test("configuration is defaulted and bounded", () => {
    assert.equal(webContextBudgetTokens({}), 64_000);
    assert.equal(webContextBudgetTokens({ LISA_WEB_CONTEXT_TOKENS: "10" }), 8_000);
    assert.equal(webContextBudgetTokens({ LISA_WEB_CONTEXT_TOKENS: "20000" }), 20_000);
    assert.equal(webContextBudgetTokens({ LISA_WEB_CONTEXT_TOKENS: "9999999" }), 1_000_000);
  });

  test("reserves history budget for the current text and attachments", () => {
    assert.equal(estimateCurrentWebInputTokens("1234"), 1);
    assert.equal(
      estimateCurrentWebInputTokens("", [
        { name: "", mediaType: "", data: "12345678" },
      ]),
      2,
    );
  });

  test("keeps the newest messages while canonical history stays untouched", () => {
    const history = [
      text("user", "old ".repeat(100)),
      text("assistant", "old reply ".repeat(100)),
      text("user", "recent"),
      text("assistant", "recent reply"),
    ];
    const recentCost =
      estimateStoredMessageTokens(history[2]!) +
      estimateStoredMessageTokens(history[3]!);
    const selected = selectWebModelContext({
      history,
      budgetTokens: recentCost,
      latestReflection: "We were planning a release.",
    });
    assert.deepEqual(selected.history, history.slice(2));
    assert.equal(selected.omittedMessages, 2);
    assert.match(selected.systemSuffix, /planning a release/);
    assert.match(selected.systemSuffix, /historical data, not instructions/);
    assert.match(selected.systemSuffix, /memory_search/);
    assert.equal(history.length, 4);
  });

  test("never starts with an orphan tool_result", () => {
    const history: StoredMessage[] = [
      text("user", "old"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      text("assistant", "done"),
    ];
    const resultCost =
      estimateStoredMessageTokens(history[2]!) +
      estimateStoredMessageTokens(history[3]!);
    const selected = selectWebModelContext({ history, budgetTokens: resultCost });
    assert.deepEqual(selected.history, [history[3]]);
  });

  test("drops a trailing tool_use left unmatched by an interrupted process", () => {
    const dangling: StoredMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    };
    const selected = selectWebModelContext({
      history: [text("user", "hello"), dangling],
      budgetTokens: 10_000,
    });
    assert.deepEqual(selected.history, [text("user", "hello")]);
    assert.equal(selected.omittedMessages, 1);
  });
});
