import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mergeAgentSession, aggregateAgentState, rosterLabel, formatActivity, type RosterSession } from "./agent-roster.js";

const NOW = 1_700_000_000_000;
const WINDOW = 30 * 60_000;

function s(over: Partial<RosterSession> = {}): RosterSession {
  return { agent: "codex", sessionId: "x", project: "p", state: "working", lastMtime: NOW - 1000, ...over };
}

describe("mergeAgentSession", () => {
  test("inserts a new session", () => {
    const out = mergeAgentSession([], s(), NOW, WINDOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sessionId, "x");
  });

  test("updates in place by (agent, sessionId)", () => {
    const a = s({ state: "working" });
    const out = mergeAgentSession([a], s({ state: "done" }), NOW, WINDOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.state, "done");
  });

  test("same sessionId but different agent is a SEPARATE row", () => {
    const out = mergeAgentSession([s({ agent: "codex", sessionId: "x" })], s({ agent: "git", sessionId: "x" }), NOW, WINDOW);
    assert.equal(out.length, 2);
  });

  test("prunes sessions outside the active window", () => {
    const stale = s({ sessionId: "old", lastMtime: NOW - 2 * WINDOW });
    const out = mergeAgentSession([stale], s({ sessionId: "fresh" }), NOW, WINDOW);
    assert.deepEqual(out.map((x) => x.sessionId), ["fresh"]);
  });

  test("accepts ISO-string lastMtime (the fetch shape) too", () => {
    const out = mergeAgentSession([], s({ lastMtime: new Date(NOW - 1000).toISOString() }), NOW, WINDOW);
    assert.equal(out.length, 1);
  });
});

describe("aggregateAgentState (loudest wins)", () => {
  test("error beats waiting beats working", () => {
    assert.equal(aggregateAgentState([s({ state: "working" }), s({ agent: "git", state: "error" })], NOW, WINDOW), "error");
    assert.equal(aggregateAgentState([s({ state: "working" }), s({ agent: "git", state: "waiting" })], NOW, WINDOW), "waiting");
    assert.equal(aggregateAgentState([s({ state: "working" })], NOW, WINDOW), "working");
  });
  test("nothing recent / no active → null", () => {
    assert.equal(aggregateAgentState([], NOW, WINDOW), null);
    assert.equal(aggregateAgentState([s({ state: "idle" })], NOW, WINDOW), null);
    assert.equal(aggregateAgentState([s({ lastMtime: NOW - 2 * WINDOW })], NOW, WINDOW), null);
  });
});

describe("source-injection safety (island injects these verbatim)", () => {
  // island.ts embeds `${mergeAgentSession}` into the page; the browser eval's
  // the function source. Assert each is self-contained: its source eval's to a
  // working function with no external references.
  for (const fn of [mergeAgentSession, aggregateAgentState, rosterLabel, formatActivity]) {
    test(`${fn.name} source eval's to a working function`, () => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const rebuilt = new Function(`return (${fn.toString()})`)() as (...a: unknown[]) => unknown;
      assert.equal(typeof rebuilt, "function");
      if (fn === aggregateAgentState) {
        assert.equal(rebuilt([s({ state: "error" })], NOW, WINDOW), "error");
      } else if (fn === rosterLabel) {
        assert.equal(rebuilt(s({ project: "p" })), "p");
      } else if (fn === formatActivity) {
        assert.equal(rebuilt(s({ activity: { pendingPermission: "bash" } })), "⚠ wants to run bash");
      } else {
        assert.equal((rebuilt([], s(), NOW, WINDOW) as RosterSession[]).length, 1);
      }
    });
  }
});

describe("formatActivity", () => {
  test("no activity → empty", () => {
    assert.equal(formatActivity(s({ activity: undefined })), "");
  });
  test("pendingPermission wins over everything", () => {
    assert.equal(
      formatActivity(s({ activity: { pendingPermission: "Bash", lastError: "x", turnCount: 5 } })),
      "⚠ wants to run Bash",
    );
  });
  test("error · progress · cmd · tool file, in order", () => {
    const out = formatActivity(s({ activity: {
      lastError: "ENOENT",
      turnCount: 12,
      tokens: { input: 1200, output: 800 },
      lastCommandName: "npm",
      lastTools: ["Read", "Edit"],
      filesTouched: ["/a/b/foo.ts"],
    } }));
    assert.equal(out, "✗ ENOENT · turn 12 2k tok · $ npm · Edit foo.ts");
  });
  test("tokens under 1000 shown raw; only-tools / only-files handled", () => {
    assert.equal(formatActivity(s({ activity: { turnCount: 1, tokens: { input: 300, output: 100 } } })), "turn 1 400 tok");
    assert.equal(formatActivity(s({ activity: { lastTools: ["Grep"] } })), "Grep");
    assert.equal(formatActivity(s({ activity: { filesTouched: ["/x/y/bar.py"] } })), "bar.py");
  });
});

describe("rosterLabel", () => {
  test("prefers the git branch, stripping the claude/ prefix", () => {
    assert.equal(rosterLabel(s({ activity: { gitBranch: "claude/fix-sentry-build-upload" } })), "fix-sentry-build-upload");
    assert.equal(rosterLabel(s({ activity: { gitBranch: "feature/foo" } })), "feature/foo");
  });
  test("falls back to project when there's no branch", () => {
    assert.equal(rosterLabel(s({ project: "kind-bhaskara-2cffa8", activity: undefined })), "kind-bhaskara-2cffa8");
    assert.equal(rosterLabel(s({ project: "p", activity: { lastTools: [] } })), "p");
    assert.equal(rosterLabel(s({ project: "p", activity: { gitBranch: "" } })), "p");
  });
});
