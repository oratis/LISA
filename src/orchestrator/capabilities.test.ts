import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_CAPABILITIES,
  DISPATCH_BACKENDS,
  formatCapabilityRecommendation,
  getAgentCapability,
  listAgentCapabilities,
  recommendAgentForTask,
} from "./capabilities.js";

describe("capability registry", () => {
  test("registers all 7 backends with distinct strengths and summaries", () => {
    assert.deepEqual(
      [...DISPATCH_BACKENDS],
      ["claude", "codex", "opencode", "aider", "copilot", "cursor", "gemini"],
    );
    const list = listAgentCapabilities();
    assert.equal(list.length, 7);
    for (const backend of DISPATCH_BACKENDS) {
      const cap = getAgentCapability(backend);
      assert.equal(cap, AGENT_CAPABILITIES[backend]);
      assert.ok(cap.strengths.length >= 3, `${backend} has strengths`);
      assert.ok(cap.summary.length > 10, `${backend} has summary`);
    }
  });
});

describe("recommendAgentForTask — deterministic routing + rationale", () => {
  test("routes large-context / docs / multimodal research tasks to gemini", () => {
    const rec = recommendAgentForTask(
      "Analyze the entire codebase documentation and screenshot diagrams to synthesize a migration report",
    );
    assert.equal(rec.recommended, "gemini");
    assert.match(rec.rationale, /Gemini CLI/);
    assert.ok(rec.matchedSignals.length >= 2);
  });

  test("routes architectural multi-file refactoring and debugging to claude", () => {
    const rec = recommendAgentForTask(
      "Refactor the multi-file authentication architecture and debug the race condition",
    );
    assert.equal(rec.recommended, "claude");
    assert.match(rec.rationale, /Claude Code/);
  });

  test("routes CI/test verification and failing test fixes to codex", () => {
    const rec = recommendAgentForTask(
      "Fix failing unit tests in CI pipeline and run shell verification checks",
    );
    assert.equal(rec.recommended, "codex");
    assert.match(rec.rationale, /OpenAI Codex/);
  });

  test("routes UI / frontend / CSS polish tasks to cursor", () => {
    const rec = recommendAgentForTask(
      "Polish the frontend CSS layout and responsive UI components quickly",
    );
    assert.equal(rec.recommended, "cursor");
    assert.match(rec.rationale, /Cursor CLI/);
  });

  test("routes git merge-conflict / small patch tasks to aider", () => {
    const rec = recommendAgentForTask("Resolve git merge conflict and make a minimal diff commit");
    assert.equal(rec.recommended, "aider");
    assert.match(rec.rationale, /Aider/);
  });

  test("routes multi-model / local Ollama tasks to opencode", () => {
    const rec = recommendAgentForTask(
      "Run this edit using local model via ollama provider-agnostic",
    );
    assert.equal(rec.recommended, "opencode");
    assert.match(rec.rationale, /OpenCode/);
  });

  test("filters by available backends and falls back gracefully", () => {
    const rec = recommendAgentForTask("Analyze the entire codebase docs and screenshots", [
      "claude",
      "codex",
    ]);
    assert.ok(rec.recommended === "claude" || rec.recommended === "codex");
    assert.equal(rec.ranked.length, 2);

    const empty = recommendAgentForTask("fix tests", []);
    assert.equal(empty.recommended, null);
    assert.match(empty.rationale, /No coding agent backends/);
  });

  test("penalizes busy agents and respects customSkills overrides", () => {
    const recBusy = recommendAgentForTask("Fix failing tests in CI", ["codex", "claude"], {
      busyAgents: ["codex"],
    });
    assert.equal(recBusy.ranked.find((r) => r.agent === "codex")?.busy, true);

    const recCustom = recommendAgentForTask("Do a custom security audit", ["aider", "copilot"], {
      customSkills: { copilot: ["security"] },
    });
    assert.equal(recCustom.recommended, "copilot");
  });

  test("formatCapabilityRecommendation renders concise readable summary", () => {
    const rec = recommendAgentForTask("Polish UI CSS layout");
    const text = formatCapabilityRecommendation(rec);
    assert.match(text, /Recommended agent: cursor/);
    assert.match(text, /Detected task signals:/);
    assert.match(text, /Runner-ups:/);
  });
});
