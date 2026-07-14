import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REFLECT_DEBOUNCE_MS,
  countUserMessages,
  decideReflect,
} from "./reflect-scheduler.js";
import type { StoredMessage } from "../types.js";

const DEBOUNCE = DEFAULT_REFLECT_DEBOUNCE_MS;

describe("decideReflect", () => {
  test("reflects once the conversation is quiet and the user added input", () => {
    const d = decideReflect({
      newUserMessages: 2,
      idleMs: DEBOUNCE + 1_000,
      debounceMs: DEBOUNCE,
      inFlight: false,
    });
    assert.equal(d.shouldReflect, true);
  });

  test("waits while the conversation is still active (not quiet yet)", () => {
    const d = decideReflect({
      newUserMessages: 5,
      idleMs: DEBOUNCE - 1_000,
      debounceMs: DEBOUNCE,
      inFlight: false,
    });
    assert.equal(d.shouldReflect, false);
    assert.equal(d.reason, "not-quiet-yet");
  });

  test("does not reflect when the user added nothing new (e.g. only idle 'dream' messages)", () => {
    const d = decideReflect({
      newUserMessages: 0,
      idleMs: DEBOUNCE * 10,
      debounceMs: DEBOUNCE,
      inFlight: false,
    });
    assert.equal(d.shouldReflect, false);
    assert.equal(d.reason, "no-new-user-input");
  });

  test("never overlaps a reflection or idle run that is already in flight", () => {
    const d = decideReflect({
      newUserMessages: 3,
      idleMs: DEBOUNCE * 2,
      debounceMs: DEBOUNCE,
      inFlight: true,
    });
    assert.equal(d.shouldReflect, false);
    assert.equal(d.reason, "in-flight");
  });

  test("exactly one new user message at the threshold reflects", () => {
    const d = decideReflect({
      newUserMessages: 1,
      idleMs: DEBOUNCE,
      debounceMs: DEBOUNCE,
      inFlight: false,
    });
    assert.equal(d.shouldReflect, true);
  });
});

describe("countUserMessages", () => {
  const mk = (role: StoredMessage["role"]): StoredMessage =>
    ({ role, content: [{ type: "text", text: "x" }] }) as StoredMessage;

  test("counts only user-role messages", () => {
    const history: StoredMessage[] = [
      mk("user"),
      mk("assistant"),
      mk("user"),
      mk("assistant"),
      mk("assistant"),
    ];
    assert.equal(countUserMessages(history), 2);
  });

  test("empty history is zero", () => {
    assert.equal(countUserMessages([]), 0);
  });

  test("difference tracks new user turns across a replaced history array", () => {
    // The server compares counts, not indices, so a wholesale history
    // replacement (compaction) can't make us re-reflect old content.
    const before = countUserMessages([mk("user"), mk("assistant")]);
    const after = countUserMessages([
      mk("user"),
      mk("assistant"),
      mk("user"),
      mk("assistant"),
    ]);
    assert.equal(after - before, 1);
  });
});
