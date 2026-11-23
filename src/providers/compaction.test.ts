import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StoredMessage } from "../types.js";
import {
  compactMessagesForProvider,
  estimateHistoryChars,
  stripEmptyAssistantMessages,
} from "./compaction.js";

describe("provider compaction & empty-assistant guard (M4)", () => {
  test("stripEmptyAssistantMessages drops empty strings and empty/blank block arrays", () => {
    const msgs: StoredMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "text", text: "", citations: null }] },
      { role: "assistant", content: [{ type: "text", text: "kept", citations: null }] },
    ];
    const cleaned = stripEmptyAssistantMessages(msgs);
    assert.equal(cleaned.length, 2);
    assert.equal(cleaned[0]?.role, "user");
    assert.equal(cleaned[1]?.role, "assistant");
  });

  test("does not compact when disabled or under threshold", () => {
    const msgs: StoredMessage[] = Array.from({ length: 14 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `msg-${i} ` + "a".repeat(50),
    }));
    const disabled = compactMessagesForProvider(msgs, { enabled: false, maxChars: 100 });
    assert.equal(disabled.compacted, false);
    assert.equal(disabled.messages.length, 14);

    const under = compactMessagesForProvider(msgs, {
      enabled: true,
      maxChars: estimateHistoryChars(msgs) + 100,
    });
    assert.equal(under.compacted, false);
  });

  test("preserves tool_use -> tool_result pairs across split boundary and respects digest cap", () => {
    const msgs: StoredMessage[] = [
      { role: "user", content: "turn 0 " + "a".repeat(200) },
      { role: "assistant", content: "reply 0 " + "b".repeat(200) },
      { role: "user", content: "turn 1 " + "c".repeat(200) },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "kb_read", input: { slug: "notes" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "note body ".repeat(30) }],
      },
      { role: "assistant", content: "used note" },
      { role: "user", content: "latest user question" },
    ];

    const res = compactMessagesForProvider(msgs, {
      enabled: true,
      maxChars: 300,
      keepRecentMessages: 3, // would naively land directly on the tool_result message!
      maxDigestChars: 600,
    });

    assert.equal(res.compacted, true);
    assert.ok(res.droppedCount >= 2);
    const first = res.messages[0];
    assert.equal(first?.role, "user");
    const firstText =
      Array.isArray(first?.content) && first.content[0]?.type === "text"
        ? first.content[0].text
        : "";
    assert.ok(firstText.includes("<compacted-history"));
    assert.ok(firstText.length <= 600);

    // Every tool_result in the compacted history must still have its matching tool_use before it.
    const seenToolUses = new Set<string>();
    for (const m of res.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === "tool_use") seenToolUses.add(b.id);
        if (b.type === "tool_result") {
          assert.ok(seenToolUses.has(b.tool_use_id), `orphan tool_result ${b.tool_use_id}`);
        }
      }
    }
  });
});
