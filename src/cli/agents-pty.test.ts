import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePtyArgs, parseSseEvents } from "./agents-pty.js";

test("parsePtyArgs: agent + task, default port", () => {
  const prev = process.env.LISA_WEB_PORT;
  delete process.env.LISA_WEB_PORT;
  try {
    assert.deepEqual(parsePtyArgs(["claude", "refactor", "the", "auth"]), {
      agent: "claude",
      task: "refactor the auth",
      port: 5757,
    });
  } finally {
    if (prev !== undefined) process.env.LISA_WEB_PORT = prev;
  }
});

test("parsePtyArgs: --port (space and =) overrides", () => {
  assert.deepEqual(parsePtyArgs(["--port", "5758", "codex", "do", "x"]), {
    agent: "codex",
    task: "do x",
    port: 5758,
  });
  assert.deepEqual(parsePtyArgs(["--port=5759", "claude", "go"]), {
    agent: "claude",
    task: "go",
    port: 5759,
  });
});

test("parsePtyArgs: errors on missing agent / task / bad port", () => {
  assert.ok("error" in parsePtyArgs([]));
  assert.ok("error" in parsePtyArgs(["claude"])); // agent but no task
  assert.ok("error" in parsePtyArgs(["--port", "0", "claude", "go"]));
});

test("parsePtyArgs: --resume adopts an idle session (claude-only, task optional)", () => {
  const prev = process.env.LISA_WEB_PORT;
  delete process.env.LISA_WEB_PORT;
  try {
    assert.deepEqual(parsePtyArgs(["--resume", "abc-123"]), {
      agent: "claude",
      task: "",
      port: 5757,
      resumeSessionId: "abc-123",
    });
    assert.deepEqual(parsePtyArgs(["--resume=xyz", "now", "run", "tests"]), {
      agent: "claude",
      task: "now run tests",
      port: 5757,
      resumeSessionId: "xyz",
    });
    assert.ok("error" in parsePtyArgs(["--resume"])); // missing id
  } finally {
    if (prev !== undefined) process.env.LISA_WEB_PORT = prev;
  }
});

test("parseSseEvents: extracts complete data frames, keeps the remainder", () => {
  const { events, rest } = parseSseEvents('data: {"text":"a"}\n\ndata: {"text":"b"}\n\ndata: partial');
  assert.deepEqual(events, ['{"text":"a"}', '{"text":"b"}']);
  assert.equal(rest, "data: partial");
});

test("parseSseEvents: multi-line data joined; comment-only frame yields nothing", () => {
  assert.deepEqual(parseSseEvents("data: line1\ndata: line2\n\n").events, ["line1\nline2"]);
  assert.deepEqual(parseSseEvents(": keepalive\n\n").events, []);
});
