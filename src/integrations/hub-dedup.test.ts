import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAdoptedSessions } from "./hub.js";
import type { AgentSession } from "./types.js";

const S = (o: Partial<AgentSession>): AgentSession => ({
  agent: "claude-code",
  sessionId: "x",
  project: "p",
  state: "working",
  stateReason: "",
  lastMtime: 0,
  ...o,
});

test("drops the observe-only twin of a resume-adopted session", () => {
  const out = dedupeAdoptedSessions([
    S({ sessionId: "uuid-1" }), // observe-only claude-code transcript
    S({ sessionId: "p1-aaaa", controllable: "pty", adoptedSessionId: "uuid-1" }), // the PTY adopting it
    S({ sessionId: "uuid-2" }), // unrelated → kept
  ]);
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["p1-aaaa", "uuid-2"],
  );
});

test("no adopts → returns the input unchanged (same reference)", () => {
  const sessions = [S({ sessionId: "a" }), S({ sessionId: "b" })];
  assert.equal(dedupeAdoptedSessions(sessions), sessions);
});

test("only observe-only twins are dropped — a controllable same-id session stays", () => {
  const out = dedupeAdoptedSessions([
    S({ sessionId: "uuid-1", controllable: "managed" }), // controllable → never dropped
    S({ sessionId: "p1", controllable: "pty", adoptedSessionId: "uuid-1" }),
  ]);
  assert.equal(out.length, 2);
});
