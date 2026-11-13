import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StoredMessage } from "../types.js";
import {
  WEB_CONTEXT_TRIM_RATIO,
  estimateCurrentWebInputTokens,
  estimateStoredMessageTokens,
  selectWebModelContext,
  selectWebModelContextForTurn,
  webContextBudgetTokens,
  type ContextAnchor,
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
      estimateCurrentWebInputTokens("", [{ name: "", mediaType: "", data: "12345678" }]),
      2,
    );
  });

  test("turn selection reserves the system prompt and truncation summary", () => {
    const history = Array.from({ length: 30 }, (_, index) =>
      text(index % 2 === 0 ? "user" : "assistant", `message ${index} `.repeat(20)),
    );
    const budgetTokens = 2_000;
    const systemPrompt = "system ".repeat(500);
    const selected = selectWebModelContextForTurn({
      history,
      systemPrompt,
      text: "current question",
      budgetTokens,
      latestReflection: "A durable summary of the earlier conversation.",
    });
    const completeEstimate =
      estimateCurrentWebInputTokens(systemPrompt + selected.systemSuffix + "current question") +
      selected.estimatedTokens;
    assert.ok(selected.omittedMessages > 0);
    assert.ok(completeEstimate <= budgetTokens);
  });

  test("keeps the newest messages while canonical history stays untouched", () => {
    const history = [
      text("user", "old ".repeat(100)),
      text("assistant", "old reply ".repeat(100)),
      text("user", "recent"),
      text("assistant", "recent reply"),
    ];
    const recentCost =
      estimateStoredMessageTokens(history[2]!) + estimateStoredMessageTokens(history[3]!);
    const selected = selectWebModelContext({
      history,
      // Over budget, the window is cut back to the trim target, not the budget.
      budgetTokens: Math.ceil(recentCost / WEB_CONTEXT_TRIM_RATIO),
      latestReflection: "We were planning a release.",
    });
    assert.deepEqual(selected.history, history.slice(2));
    assert.equal(selected.omittedMessages, 2);
    assert.deepEqual(selected.anchor, { start: 2, message: history[2] });
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
      estimateStoredMessageTokens(history[2]!) + estimateStoredMessageTokens(history[3]!);
    const selected = selectWebModelContext({
      history,
      budgetTokens: Math.ceil(resultCost / WEB_CONTEXT_TRIM_RATIO),
    });
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
    // Nothing was omitted from the HEAD, so there is nothing to explain and
    // nothing to anchor.
    assert.equal(selected.systemSuffix, "");
    assert.equal(selected.anchor, undefined);
  });
});

/**
 * A provider's prompt cache is a prefix match, so what a long chat costs is
 * decided by how often the request stops being an extension of the previous
 * one. These tests replay a conversation turn by turn, the way /chat does.
 */
describe("web context stays cacheable across turns", () => {
  const SYSTEM = "system prompt ".repeat(200);
  const BUDGET = 4_000;
  const turn = (n: number): StoredMessage[] => [
    text("user", `question ${n} `.repeat(12)),
    text("assistant", `answer ${n} `.repeat(30)),
  ];

  /** One /chat turn: select the window, then the turn's messages are appended. */
  function replay(turns: number, opts: { carryAnchor: boolean }) {
    const history: StoredMessage[] = [];
    let anchor: ContextAnchor | undefined;
    const seen: Array<{ first: StoredMessage | undefined; suffix: string; total: number }> = [];
    for (let n = 0; n < turns; n++) {
      const question = `question ${n} `.repeat(12);
      const selected = selectWebModelContextForTurn({
        history,
        systemPrompt: SYSTEM,
        text: question,
        budgetTokens: BUDGET,
        latestReflection: "They are planning a release.",
        anchor: opts.carryAnchor ? anchor : undefined,
      });
      anchor = selected.anchor;
      seen.push({
        first: selected.history[0],
        suffix: selected.systemSuffix,
        total:
          estimateCurrentWebInputTokens(SYSTEM + selected.systemSuffix + question) +
          selected.estimatedTokens,
      });
      history.push(...turn(n));
    }
    return seen;
  }

  /** Turns whose window does not start where the previous turn's did. */
  const moves = (seen: ReturnType<typeof replay>) =>
    seen.filter((s, i) => i > 0 && s.first !== seen[i - 1]!.first).length;

  test("the window start holds for many turns instead of sliding every turn", () => {
    const TURNS = 80;
    const seen = replay(TURNS, { carryAnchor: true });
    const overBudgetFrom = seen.findIndex((s) => s.suffix !== "");
    assert.ok(overBudgetFrom > 0 && overBudgetFrom < TURNS / 2, "the replay must go over budget");
    const overBudget = seen.slice(overBudgetFrom);

    // Every turn still fits the budget — holding the start never overshoots it.
    for (const s of seen) assert.ok(s.total <= BUDGET, `turn used ${s.total} > ${BUDGET}`);

    // Once over budget, the old behaviour moved the start on every turn. Now
    // it moves once per ~30% of the budget's worth of new conversation.
    const held = moves(overBudget);
    assert.ok(held <= overBudget.length / 4, `window moved on ${held}/${overBudget.length} turns`);
    assert.ok(held >= 1, "the window does still move when the budget is reached again");

    // Without the anchor (a caller that forgets it) every over-budget turn is
    // re-cut to the trim target — the baseline this is measured against.
    const forgetful = replay(TURNS, { carryAnchor: false }).slice(overBudgetFrom);
    assert.ok(moves(forgetful) > held * 3);
  });

  test("the system suffix is byte-identical from turn to turn", () => {
    const seen = replay(80, { carryAnchor: true }).filter((s) => s.suffix !== "");
    assert.ok(seen.length > 20);
    // It used to carry a count of omitted messages, which changed every turn
    // and re-wrote the provider's 1h system-prompt cache each time.
    assert.equal(new Set(seen.map((s) => s.suffix)).size, 1);
    assert.doesNotMatch(seen[0]!.suffix, /\d/);
  });

  test("an anchor from a different or edited history is ignored, not trusted", () => {
    const history = Array.from({ length: 40 }, (_, n) => turn(n)).flat();
    const first = selectWebModelContext({ history, budgetTokens: 2_000 });
    assert.ok(first.anchor && first.anchor.start > 0);
    const again = selectWebModelContext({ history, budgetTokens: 2_000, anchor: first.anchor });
    assert.equal(again.anchor?.start, first.anchor.start);

    // The same conversation reloaded from disk: equal content, new objects.
    const reloaded = history.map((m) => structuredClone(m));
    const fresh = selectWebModelContext({ history: reloaded, budgetTokens: 2_000 });
    const stale = selectWebModelContext({
      history: reloaded,
      budgetTokens: 2_000,
      anchor: first.anchor,
    });
    assert.deepEqual(stale, fresh);

    // An anchor past the end, or at 0, cannot be held either.
    for (const start of [0, history.length, history.length + 5]) {
      const odd = selectWebModelContext({
        history,
        budgetTokens: 2_000,
        anchor: { start, message: history[Math.min(start, history.length - 1)]! },
      });
      assert.deepEqual(odd, first, String(start));
    }
  });

  test("a held start never grows the window past the budget", () => {
    const history = Array.from({ length: 40 }, (_, n) => turn(n)).flat();
    const first = selectWebModelContext({ history, budgetTokens: 2_000 });
    // A much smaller budget next turn (a large attachment took the room): the
    // old start no longer fits, so the window moves forward rather than over.
    const squeezed = selectWebModelContext({ history, budgetTokens: 600, anchor: first.anchor });
    assert.ok(squeezed.estimatedTokens <= 600);
    assert.ok(squeezed.anchor!.start > first.anchor!.start);
    // And it does not move back when the room returns.
    const roomy = selectWebModelContext({ history, budgetTokens: 2_000, anchor: squeezed.anchor });
    assert.equal(roomy.anchor!.start, squeezed.anchor!.start);
  });
});
