import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createEventRenderer,
  formatDuration,
  summarizeToolInput,
  type RendererOptions,
} from "./render.js";
import type { AgentEvent } from "../types.js";

/** A writer that just accumulates — the "non-TTY" case the tests care about. */
function sink(): { text: () => string; write(chunk: string): void } {
  const chunks: string[] = [];
  return { write: (c: string) => void chunks.push(c), text: () => chunks.join("") };
}

function harness(opts: Partial<RendererOptions> = {}) {
  const stdout = sink();
  const stderr = sink();
  // A clock the test advances by hand, and timers that never touch the event
  // loop, so a leaked interval can't outlive the test on CI.
  let clock = 0;
  const intervals: (() => void)[] = [];
  const r = createEventRenderer({
    stdout,
    stderr,
    now: () => clock,
    timers: {
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length - 1;
      },
      clearInterval: () => {},
    },
    ...opts,
  });
  return {
    r,
    stdout,
    stderr,
    intervals,
    advance: (ms: number) => {
      clock += ms;
    },
    send: (e: AgentEvent) => r.onEvent(e),
  };
}

describe("createEventRenderer — piped (non-TTY) output", () => {
  test("stdout carries Lisa's text and nothing else", () => {
    const h = harness();
    h.r.beginTurn();
    h.send({ type: "text_delta", text: "hello " });
    h.send({ type: "tool_call_start", toolName: "bash", toolInput: { command: "npm test" } });
    h.send({ type: "tool_call_end", toolName: "bash", toolResult: "ok" });
    h.send({ type: "text_delta", text: "world" });
    h.r.endTurn();
    assert.equal(h.stdout.text(), "hello world\n");
  });

  test("a tool call is one line running + one line done", () => {
    const h = harness();
    h.r.beginTurn();
    h.send({ type: "tool_call_start", toolName: "bash", toolInput: { command: "npm test" } });
    h.advance(1200);
    h.send({ type: "tool_call_end", toolName: "bash", toolResult: "42 passing" });
    h.r.endTurn();
    const lines = h.stderr.text().split("\n").filter((l) => l.length > 0);
    assert.deepEqual(lines, ["⚙ bash  npm test", "✓ bash (1.2s)"]);
  });

  test("a failed tool shows only the first line of the error", () => {
    const h = harness();
    h.r.beginTurn();
    h.send({ type: "tool_call_start", toolName: "bash", toolInput: { command: "false" } });
    h.advance(300);
    h.send({
      type: "tool_call_end",
      toolName: "bash",
      toolResult: "Error: exit 1\n  at foo\n  at bar",
      isError: true,
    });
    h.r.endTurn();
    const out = h.stderr.text();
    assert.match(out, /✗ bash \(0\.3s\): Error: exit 1\n/);
    assert.doesNotMatch(out, /at foo/);
  });

  test("results stay hidden unless --verbose", () => {
    const quiet = harness();
    quiet.r.beginTurn();
    quiet.send({ type: "tool_call_start", toolName: "read", toolInput: { path: "/tmp/x" } });
    quiet.send({ type: "tool_call_end", toolName: "read", toolResult: "secret payload" });
    assert.doesNotMatch(quiet.stderr.text(), /secret payload/);

    const loud = harness({ verbose: true });
    loud.r.beginTurn();
    loud.send({ type: "tool_call_start", toolName: "read", toolInput: { path: "/tmp/x" } });
    loud.send({ type: "tool_call_end", toolName: "read", toolResult: "secret payload" });
    assert.match(loud.stderr.text(), /secret payload/);
  });

  test("thinking is announced once per turn and never quoted", () => {
    const h = harness();
    h.r.beginTurn();
    h.send({ type: "thinking_delta", text: "the user's password is hunter2" });
    h.send({ type: "thinking_delta", text: "more private reasoning" });
    h.r.endTurn();
    const out = h.stderr.text();
    assert.equal(out.split("thinking…").length - 1, 1);
    assert.doesNotMatch(out, /hunter2|private reasoning/);
  });

  test("system_prompt_rebuilt reads as [soul updated]", () => {
    const h = harness();
    h.send({ type: "system_prompt_rebuilt", message: "3 files changed" });
    assert.equal(h.stderr.text(), "[soul updated]\n");
    const loud = harness({ verbose: true });
    loud.send({ type: "system_prompt_rebuilt", message: "3 files changed" });
    assert.equal(loud.stderr.text(), "[soul updated] 3 files changed\n");
  });

  test("no spinner and no escape codes without a TTY", () => {
    const h = harness();
    h.r.beginTurn();
    h.send({ type: "turn_start" });
    h.r.endTurn();
    assert.equal(h.intervals.length, 0);
    assert.doesNotMatch(h.stderr.text(), /\x1b/);
  });

  test("colour is opt-in and only ever decorates stderr", () => {
    const h = harness({ color: true });
    h.r.beginTurn();
    h.send({ type: "text_delta", text: "plain" });
    h.send({ type: "error", message: "boom" });
    h.r.endTurn();
    assert.equal(h.stdout.text(), "plain\n");
    assert.match(h.stderr.text(), /\x1b\[31m\[error\] boom\x1b\[39m/);
  });
});

describe("createEventRenderer — TTY output", () => {
  test("the spinner starts on beginTurn and stops at the first text", () => {
    const h = harness({ tty: true, columns: 80 });
    h.r.beginTurn();
    assert.equal(h.intervals.length, 1, "one interval, unref'd in production");
    h.send({ type: "text_delta", text: "hi" });
    // Spinner cleared, then the label, then the text on stdout.
    assert.match(h.stderr.text(), /\r\x1b\[K.*Lisa> $/s);
    assert.equal(h.stdout.text(), "hi");
    h.r.endTurn();
  });

  test("the in-flight tool line is overwritten in place by its result", () => {
    const h = harness({ tty: true, columns: 80 });
    h.r.beginTurn();
    h.send({ type: "tool_call_start", toolName: "bash", toolInput: { command: "sleep 1" } });
    h.advance(1000);
    h.send({ type: "tool_call_end", toolName: "bash", toolResult: "" });
    h.r.endTurn();
    const out = h.stderr.text();
    assert.match(out, /⚙ bash {2}sleep 1\r\x1b\[K✓ bash \(1\.0s\)\n/);
  });

  test("a long tool summary is truncated to the terminal width", () => {
    const h = harness({ tty: true, columns: 40 });
    h.r.beginTurn();
    h.send({ type: "tool_call_start", toolName: "bash", toolInput: { command: "x".repeat(200) } });
    const running = h.stderr.text().split("\r\x1b[K").pop() ?? "";
    assert.ok(running.length < 40, `expected a fitted line, got ${running.length} chars`);
    assert.ok(running.endsWith("…"));
    h.r.endTurn();
  });
});

describe("summarizeToolInput", () => {
  test("prefers the key that says what the call is about", () => {
    assert.equal(summarizeToolInput({ command: "npm test", timeout: 5 }), "npm test");
    assert.equal(summarizeToolInput({ file_path: "/a/b.ts", content: "…" }), "/a/b.ts");
    assert.equal(summarizeToolInput({ action: "list", path: "/a" }), "list /a");
    assert.equal(summarizeToolInput({ action: "health" }), "health");
  });

  test("collapses newlines so a line stays a line", () => {
    assert.equal(summarizeToolInput({ command: "a\n  b\tc" }), "a b c");
  });

  test("falls back to compact JSON, and truncates", () => {
    assert.equal(summarizeToolInput({ n: 1 }), '{"n":1}');
    assert.equal(summarizeToolInput({}), "");
    assert.equal(summarizeToolInput(null), "");
    assert.equal(summarizeToolInput({ command: "y".repeat(200) }, 10).length, 10);
  });
});

describe("formatDuration", () => {
  test("sub-minute is one decimal of seconds", () => {
    assert.equal(formatDuration(1234), "1.2s");
    assert.equal(formatDuration(300), "0.3s");
    assert.equal(formatDuration(-5), "0.0s");
  });

  test("a minute or more reads as m + padded s", () => {
    assert.equal(formatDuration(65_000), "1m 05s");
    assert.equal(formatDuration(600_000), "10m 00s");
  });
});
