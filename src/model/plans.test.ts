import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parsePlanRef,
  selectedPlan,
  detectPlan,
  detectPlans,
  PLAN_IDS,
  type PlanProbe,
} from "./plans.js";

/** A probe that finds nothing, overridable per test. Pure inputs only. */
function fakeProbe(over: Partial<PlanProbe> = {}): PlanProbe {
  return {
    home: "/home/u",
    platform: "linux",
    env: {},
    exists: () => false,
    readdir: () => [],
    onPath: () => false,
    ...over,
  };
}

describe("parsePlanRef", () => {
  test("plan://<id> → that id", () => {
    assert.equal(parsePlanRef("plan://claude"), "claude");
    assert.equal(parsePlanRef("plan://codex"), "codex");
    assert.equal(parsePlanRef("plan://copilot"), "copilot");
  });
  test("case-insensitive on scheme and id", () => {
    assert.equal(parsePlanRef("PLAN://Claude"), "claude");
  });
  test("unknown id, non-plan refs, and empty → null", () => {
    assert.equal(parsePlanRef("plan://gemini"), null);
    assert.equal(parsePlanRef("local://qwen"), null);
    assert.equal(parsePlanRef("gpt-4o"), null);
    assert.equal(parsePlanRef("plan://"), null);
  });
});

describe("selectedPlan", () => {
  test("reads + validates LISA_CODING_PLAN", () => {
    assert.equal(selectedPlan({ LISA_CODING_PLAN: "claude" }), "claude");
    assert.equal(selectedPlan({ LISA_CODING_PLAN: "CODEX" }), "codex");
  });
  test("absent / unknown → null", () => {
    assert.equal(selectedPlan({}), null);
    assert.equal(selectedPlan({ LISA_CODING_PLAN: "nope" }), null);
  });
});

describe("detectPlan: claude", () => {
  test("not installed → unavailable", () => {
    const s = detectPlan("claude", fakeProbe());
    assert.equal(s.available, false);
    assert.equal(s.binary, null);
    assert.match(s.detail, /install/);
  });
  test("on PATH + credentials file → available & logged in", () => {
    const s = detectPlan(
      "claude",
      fakeProbe({
        onPath: (c) => c === "claude",
        exists: (p) => p === "/home/u/.claude/.credentials.json",
      }),
    );
    assert.equal(s.available, true);
    assert.equal(s.binary, "claude");
    assert.equal(s.loggedIn, true);
    assert.equal(s.detail, "ready");
  });
  test("OAuth token env counts as logged in", () => {
    const s = detectPlan(
      "claude",
      fakeProbe({ onPath: () => true, env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }),
    );
    assert.equal(s.loggedIn, true);
  });
  test("macOS without a creds file → login unknown (Keychain), not logged out", () => {
    const s = detectPlan("claude", fakeProbe({ platform: "darwin", onPath: () => true }));
    assert.equal(s.available, true);
    assert.equal(s.loggedIn, null);
  });
  test("macOS app-bundle binary is detected without PATH", () => {
    const bundle =
      "/home/u/Library/Application Support/Claude/claude-code/1.2.3/claude.app/Contents/MacOS/claude";
    const s = detectPlan(
      "claude",
      fakeProbe({
        platform: "darwin",
        readdir: (p) => (p.endsWith("claude-code") ? ["1.2.3", "0.9.0", "junk"] : []),
        exists: (p) => p === bundle,
      }),
    );
    assert.equal(s.binary, bundle);
    assert.equal(s.available, true);
  });
  test("LISA_PTY_CLAUDE_CMD override is honored", () => {
    const s = detectPlan(
      "claude",
      fakeProbe({ env: { LISA_PTY_CLAUDE_CMD: "/opt/claude" }, onPath: (c) => c === "/opt/claude" }),
    );
    assert.equal(s.binary, "/opt/claude");
  });
});

describe("detectPlan: codex", () => {
  test("on PATH + auth.json → available & logged in", () => {
    const s = detectPlan(
      "codex",
      fakeProbe({ onPath: (c) => c === "codex", exists: (p) => p === "/home/u/.codex/auth.json" }),
    );
    assert.equal(s.available, true);
    assert.equal(s.loggedIn, true);
  });
  test("CODEX_HOME relocates the auth.json check", () => {
    const s = detectPlan(
      "codex",
      fakeProbe({
        env: { CODEX_HOME: "/custom/codex" },
        onPath: () => true,
        exists: (p) => p === "/custom/codex/auth.json",
      }),
    );
    assert.equal(s.loggedIn, true);
  });
  test("installed but no auth.json → login unknown", () => {
    const s = detectPlan("codex", fakeProbe({ onPath: () => true }));
    assert.equal(s.available, true);
    assert.equal(s.loggedIn, null);
  });
});

describe("detectPlan: copilot", () => {
  test("is experimental; falls back to gh", () => {
    const s = detectPlan("copilot", fakeProbe({ onPath: (c) => c === "gh" }));
    assert.equal(s.experimental, true);
    assert.equal(s.binary, "gh");
    assert.equal(s.loggedIn, null);
  });
});

describe("detectPlans", () => {
  test("returns all known plans, in order", () => {
    const all = detectPlans(fakeProbe());
    assert.deepEqual(all.map((p) => p.id), [...PLAN_IDS]);
  });
});
