import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mapOpencodeSession,
  parseLastMessage,
  OpencodeObserver,
  type OpencodeRow,
} from "./observer.js";

// A real assistant message.data blob (trimmed) captured from opencode 1.15.
const REAL_ASSISTANT_ERROR =
  '{"role":"assistant","mode":"build","path":{"cwd":"/private/tmp/oc-demo"},' +
  '"time":{"created":1780332620711,"completed":1780332622092},' +
  '"error":{"name":"APIError","data":{"message":"Not Found","statusCode":404}}}';

describe("parseLastMessage", () => {
  test("assistant + completed + error → error with message", () => {
    const m = parseLastMessage(REAL_ASSISTANT_ERROR);
    assert.equal(m.role, "assistant");
    assert.equal(m.completed, true);
    assert.equal(m.error, true);
    assert.equal(m.errorReason, "Not Found");
  });
  test("assistant + completed, no error", () => {
    const m = parseLastMessage('{"role":"assistant","time":{"created":1,"completed":2}}');
    assert.equal(m.completed, true);
    assert.equal(m.error, false);
  });
  test("assistant streaming (no completed)", () => {
    const m = parseLastMessage('{"role":"assistant","time":{"created":1}}');
    assert.equal(m.role, "assistant");
    assert.equal(m.completed, false);
  });
  test("user role", () => {
    assert.equal(parseLastMessage('{"role":"user","time":{"created":1}}').role, "user");
  });
  test("null / garbage → empty", () => {
    assert.deepEqual(parseLastMessage(null), {});
    assert.deepEqual(parseLastMessage("{not json"), {});
  });
});

describe("mapOpencodeSession — state mapping", () => {
  const base: OpencodeRow = {
    id: "ses_1",
    directory: "/Users/me/proj",
    title: "Refactor auth",
    agent: "build",
    time_updated: 1780332620736,
  };

  test("archived → done", () => {
    const s = mapOpencodeSession({ ...base, time_archived: 1780332999999 });
    assert.equal(s.state, "done");
    assert.equal(s.stateReason, "archived");
    assert.equal(s.agent, "opencode");
    assert.equal(s.sessionId, "ses_1");
    assert.equal(s.cwd, "/Users/me/proj");
    assert.equal(s.project, "proj");
  });

  test("compacting → working", () => {
    const s = mapOpencodeSession({ ...base, time_compacting: 123 });
    assert.equal(s.state, "working");
    assert.equal(s.stateReason, "compacting");
  });

  test("latest message errored → error", () => {
    const s = mapOpencodeSession({ ...base, last_msg: REAL_ASSISTANT_ERROR });
    assert.equal(s.state, "error");
    assert.equal(s.stateReason, "Not Found");
  });

  test("assistant completed → waiting", () => {
    const s = mapOpencodeSession({ ...base, last_msg: '{"role":"assistant","time":{"completed":9}}' });
    assert.equal(s.state, "waiting");
  });

  test("assistant streaming → working", () => {
    const s = mapOpencodeSession({ ...base, last_msg: '{"role":"assistant","time":{"created":9}}' });
    assert.equal(s.state, "working");
    assert.equal(s.stateReason, "assistant-streaming");
  });

  test("user turn → working", () => {
    const s = mapOpencodeSession({ ...base, last_msg: '{"role":"user","time":{"created":9}}' });
    assert.equal(s.state, "working");
    assert.equal(s.stateReason, "user");
  });

  test("no messages → idle", () => {
    const s = mapOpencodeSession({ ...base, last_msg: null });
    assert.equal(s.state, "idle");
  });

  test("tokens surface in activity for cost tracking", () => {
    const s = mapOpencodeSession({ ...base, tokens_input: 1500, tokens_output: 800 });
    assert.deepEqual(s.activity?.tokens, { input: 1500, output: 800 });
  });
});

describe("OpencodeObserver — polling + emit", () => {
  const row = (over: Partial<OpencodeRow> = {}): OpencodeRow => ({
    id: "ses_x",
    directory: "/p",
    title: "t",
    time_updated: 1780332620000,
    ...over,
  });

  test("emits on first poll, re-emits only on change", async () => {
    let i = 0;
    const polls: OpencodeRow[][] = [
      [row({ id: "a", last_msg: '{"role":"user"}' })], // working
      [row({ id: "a", last_msg: '{"role":"user"}' })], // unchanged
      [row({ id: "a", last_msg: '{"role":"assistant","time":{"completed":1}}', time_updated: 1780332620001 })], // waiting
    ];
    const emitted: string[] = [];
    const obs = new OpencodeObserver({
      enabled: true,
      fetchRows: async () => polls[Math.min(i++, polls.length - 1)] ?? [],
      now: () => 1780332620000 + 1000,
      activeWindowMs: 10 ** 12,
    });
    await obs.start((s) => emitted.push(s.state));
    await obs.poll();
    await obs.poll();
    assert.deepEqual(emitted, ["working", "waiting"]);
    assert.equal(obs.list().length, 1);
    await obs.stop();
  });

  test("fetcher failure is swallowed", async () => {
    const obs = new OpencodeObserver({
      enabled: true,
      fetchRows: async () => {
        throw new Error("sqlite3 missing");
      },
    });
    await obs.start(() => {});
    await obs.poll();
    assert.deepEqual(obs.list(), []);
    await obs.stop();
  });
});
