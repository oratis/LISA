import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeConfig,
  loadScreenAdvisorConfig,
  saveScreenAdvisorConfig,
  parseSuggestion,
  analyzeScreenshot,
  DEFAULT_SCREEN_ADVISOR_CONFIG,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  type SuggestionProvider,
} from "./engine.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-screenadv-"));
const CFG = path.join(TMP, "screen-advisor.json");

beforeEach(() => {
  fs.rmSync(CFG, { force: true });
});

describe("normalizeConfig", () => {
  test("defaults: disabled, 10 min", () => {
    assert.deepEqual(normalizeConfig(undefined), DEFAULT_SCREEN_ADVISOR_CONFIG);
    assert.equal(DEFAULT_SCREEN_ADVISOR_CONFIG.enabled, false); // privacy: off by default
  });
  test("enabled only when strictly true", () => {
    assert.equal(normalizeConfig({ enabled: true }).enabled, true);
    assert.equal(normalizeConfig({ enabled: 1 as unknown as boolean }).enabled, false);
    assert.equal(normalizeConfig({ enabled: undefined }).enabled, false);
  });
  test("interval clamps + rounds", () => {
    assert.equal(normalizeConfig({ intervalMinutes: 0 }).intervalMinutes, MIN_INTERVAL_MINUTES);
    assert.equal(normalizeConfig({ intervalMinutes: 9999 }).intervalMinutes, MAX_INTERVAL_MINUTES);
    assert.equal(normalizeConfig({ intervalMinutes: 10.7 }).intervalMinutes, 11);
    assert.equal(normalizeConfig({ intervalMinutes: NaN }).intervalMinutes, 10);
  });
});

describe("load/save config", () => {
  test("missing file → defaults", async () => {
    assert.deepEqual(await loadScreenAdvisorConfig(CFG), DEFAULT_SCREEN_ADVISOR_CONFIG);
  });
  test("round-trips through disk, normalized", async () => {
    const saved = await saveScreenAdvisorConfig({ enabled: true, intervalMinutes: 1 }, CFG);
    assert.equal(saved.intervalMinutes, MIN_INTERVAL_MINUTES); // clamped on save
    const loaded = await loadScreenAdvisorConfig(CFG);
    assert.deepEqual(loaded, { enabled: true, intervalMinutes: MIN_INTERVAL_MINUTES });
  });
  test("corrupt file → defaults (no throw)", async () => {
    fs.writeFileSync(CFG, "{not json");
    assert.deepEqual(await loadScreenAdvisorConfig(CFG), DEFAULT_SCREEN_ADVISOR_CONFIG);
  });
});

describe("parseSuggestion", () => {
  test("plain JSON object", () => {
    const s = parseSuggestion('{"title":"Fix the failing test","rationale":"auth.test.ts is red","task":"Open src/auth.test.ts and fix the failing assertion"}');
    assert.equal(s?.title, "Fix the failing test");
    assert.equal(s?.rationale, "auth.test.ts is red");
    assert.match(s!.task, /auth\.test\.ts/);
  });
  test("strips ```json fences", () => {
    const s = parseSuggestion('```json\n{"title":"Do X","task":"do x in foo.ts"}\n```');
    assert.equal(s?.title, "Do X");
  });
  test("extracts object embedded in prose", () => {
    const s = parseSuggestion('Sure! {"title":"Do X","task":"do x"} hope that helps');
    assert.equal(s?.title, "Do X");
  });
  test('{"skip":true} → null', () => {
    assert.equal(parseSuggestion('{"skip":true}'), null);
  });
  test("missing title or task → null", () => {
    assert.equal(parseSuggestion('{"rationale":"only this"}'), null);
    assert.equal(parseSuggestion('{"title":"no task"}'), null);
  });
  test("garbage / empty → null", () => {
    assert.equal(parseSuggestion(""), null);
    assert.equal(parseSuggestion(null), null);
    assert.equal(parseSuggestion("not json at all"), null);
  });
  test("over-long fields are truncated", () => {
    const s = parseSuggestion(JSON.stringify({ title: "t".repeat(500), task: "x".repeat(5000) }));
    assert.ok((s?.title.length ?? 0) <= 120);
    assert.ok((s?.task.length ?? 0) <= 2000);
  });
});

describe("analyzeScreenshot", () => {
  function fakeProvider(reply: string): SuggestionProvider {
    return {
      async runTurn(opts) {
        // assert the image rides along as a base64 image block
        const content = opts.messages[0]!.content as Array<{ type: string }>;
        assert.ok(content.some((b) => b.type === "image"), "image block present");
        return { content: [{ type: "text", text: reply }] };
      },
    };
  }

  test("returns the parsed suggestion", async () => {
    const s = await analyzeScreenshot({
      provider: fakeProvider('{"title":"Add a test","task":"write a test for foo"}'),
      model: "m",
      imageBase64: "AAAA",
    });
    assert.equal(s?.title, "Add a test");
  });

  test("skip reply → null", async () => {
    const s = await analyzeScreenshot({
      provider: fakeProvider('{"skip":true}'),
      model: "m",
      imageBase64: "AAAA",
    });
    assert.equal(s, null);
  });
});
