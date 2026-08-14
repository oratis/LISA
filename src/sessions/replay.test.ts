import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { replaySessionFile } from "./replay.js";

/**
 * H3 acceptance (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §4): given a stored
 * session, rebuild the (systemPrompt, messages) input of every turn offline.
 */

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const HEADER = {
  type: "session",
  id: "20260814-120000-abc",
  version: 2,
  startedAt: "2026-08-14T12:00:00.000Z",
  cwd: "/work",
  model: "claude-opus-5",
};

const V1_HEADER = { ...HEADER, version: 1 };

function prompt(ts: string, text: string, reason: "initial" | "rebuilt" = "initial") {
  return { type: "prompt", ts, fingerprint: `fp-${text}`, text, reason };
}
function user(ts: string, text: string) {
  return { type: "message", ts, message: { role: "user", content: text } };
}
function assistant(ts: string, text: string) {
  return { type: "message", ts, message: { role: "assistant", content: text } };
}

describe("replaySessionFile — turn reconstruction", () => {
  test("each turn carries the messages that preceded it, not the ones after", () => {
    const raw = jsonl(
      HEADER,
      prompt("t0", "You are Lisa."),
      user("t1", "hello"),
      assistant("t2", "hi"),
      user("t3", "again"),
      assistant("t4", "still here"),
    );
    const replay = replaySessionFile(raw);

    assert.equal(replay.turns.length, 2);
    assert.deepEqual(
      replay.turns[0]!.messages.map((m) => m.content),
      ["hello"],
    );
    assert.deepEqual(
      replay.turns[1]!.messages.map((m) => m.content),
      ["hello", "hi", "again"],
      "turn 2 saw turn 1's exchange",
    );
    assert.equal(replay.turns[1]!.assistant.content, "still here");
  });

  test("a mid-session prompt rebuild applies from the next turn onward", () => {
    const raw = jsonl(
      HEADER,
      prompt("t0", "persona A"),
      user("t1", "who are you"),
      assistant("t2", "A"),
      // she calls soul_patch; the loop rebuilds before the next provider call
      prompt("t3", "persona B", "rebuilt"),
      user("t4", "and now"),
      assistant("t5", "B"),
    );
    const replay = replaySessionFile(raw);

    assert.equal(replay.turns[0]!.systemPrompt, "persona A");
    assert.equal(replay.turns[0]!.promptReason, "initial");
    assert.equal(replay.turns[1]!.systemPrompt, "persona B");
    assert.equal(replay.turns[1]!.promptReason, "rebuilt");
  });

  test("prompt timeline records which turn first ran under each prompt", () => {
    const raw = jsonl(
      HEADER,
      prompt("t0", "A"),
      user("t1", "x"),
      assistant("t2", "y"),
      prompt("t3", "B", "rebuilt"),
      user("t4", "x"),
      assistant("t5", "y"),
      // recorded but the run died before the provider answered
      prompt("t6", "C", "rebuilt"),
    );
    const replay = replaySessionFile(raw);

    assert.deepEqual(
      replay.promptChanges.map((c) => [c.fingerprint, c.firstTurn]),
      [
        ["fp-A", 1],
        ["fp-B", 2],
        ["fp-C", null],
      ],
    );
  });

  test("tool turns count as turns — the assistant message is what closes one", () => {
    const raw = jsonl(
      HEADER,
      prompt("t0", "P"),
      user("t1", "read the file"),
      { type: "message", ts: "t2", message: { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "read", input: {} }] } },
      { type: "message", ts: "t3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "contents" }] } },
      assistant("t4", "it says contents"),
    );
    const replay = replaySessionFile(raw);

    assert.equal(replay.turns.length, 2, "one call to emit the tool_use, one to answer");
    assert.equal(replay.turns[1]!.messages.length, 3, "the tool_result was in the second call's input");
  });
});

describe("replaySessionFile — honesty about what was not recorded", () => {
  test("a pre-H3 session reports promptsRecorded=false with null prompts", () => {
    const raw = jsonl(V1_HEADER, user("t1", "hello"), assistant("t2", "hi"));
    const replay = replaySessionFile(raw);

    assert.equal(replay.promptsRecorded, false);
    assert.equal(replay.turns[0]!.systemPrompt, null);
    assert.deepEqual(replay.promptChanges, []);
  });

  test("turns before the first recorded prompt keep a null prompt, not the later one", () => {
    const raw = jsonl(
      HEADER,
      user("t1", "hello"),
      assistant("t2", "hi"),
      prompt("t3", "persona", "rebuilt"),
      user("t4", "again"),
      assistant("t5", "yes"),
    );
    const replay = replaySessionFile(raw);

    assert.equal(replay.turns[0]!.systemPrompt, null);
    assert.equal(replay.turns[1]!.systemPrompt, "persona");
  });

  test("other entry kinds are ignored, and a torn tail line is survivable", () => {
    const raw =
      jsonl(
        HEADER,
        prompt("t0", "P"),
        { type: "reflection", ts: "t1", summary: "a reflection" },
        { type: "model_change", ts: "t2", model: "other-model" },
        user("t3", "hello"),
        assistant("t4", "hi"),
      ) + '{"type":"message","ts":"t5","mess';

    const replay = replaySessionFile(raw);
    assert.equal(replay.turns.length, 1);
    assert.deepEqual(replay.turns[0]!.messages.map((m) => m.content), ["hello"]);
  });

  test("an empty file is an error, not a silently empty replay", () => {
    assert.throws(() => replaySessionFile(""), /empty/);
  });
});
