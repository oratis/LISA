import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  usageTokens,
  aggregateUsage,
  startOfLocalDay,
  formatTokens,
  formatUsage,
  readClaudeUsage,
  planUsage,
} from "./plan-usage.js";

describe("usageTokens", () => {
  test("sums input + output + both cache fields", () => {
    assert.equal(
      usageTokens({
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 1000,
      }),
      1115,
    );
  });
  test("tolerates missing / non-numeric fields", () => {
    assert.equal(usageTokens({ input_tokens: 7 }), 7);
    assert.equal(usageTokens({ input_tokens: "x" as unknown as number }), 0);
    assert.equal(usageTokens({}), 0);
  });
});

describe("aggregateUsage", () => {
  const now = 1_000_000_000;
  const hour = 3_600_000;
  test("buckets entries into window vs today", () => {
    const dayStart = now - 10 * hour;
    const r = aggregateUsage(
      [
        { atMs: now - 1 * hour, tokens: 100 }, // in 5h window + today
        { atMs: now - 6 * hour, tokens: 200 }, // outside 5h, inside today
        { atMs: now - 30 * hour, tokens: 400 }, // outside both
      ],
      now,
      5 * hour,
      dayStart,
    );
    assert.equal(r.windowTokens, 100);
    assert.equal(r.todayTokens, 300);
  });
});

describe("startOfLocalDay", () => {
  test("is <= now and within 24h before it", () => {
    const now = Date.parse("2026-06-18T14:33:35.902Z");
    const s = startOfLocalDay(now);
    assert.ok(s <= now);
    assert.ok(now - s < 24 * 3_600_000);
  });
});

describe("formatTokens / formatUsage", () => {
  test("compacts magnitudes", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(12_300), "12K");
    assert.equal(formatTokens(1_240_000), "1.2M");
    assert.equal(formatTokens(2_000_000_000), "2.0B");
  });
  test("usage line reads naturally", () => {
    assert.equal(
      formatUsage({ windowTokens: 1_200_000, windowHours: 5, todayTokens: 4_800_000, sessions: 2 }),
      "1.2M tok in 5h · 4.8M today",
    );
  });
});

describe("readClaudeUsage — real scan over a temp transcript dir", () => {
  test("sums only in-window/today entries from local jsonl", () => {
    const now = Date.parse("2026-06-18T20:00:00.000Z");
    const hour = 3_600_000;
    const home = mkdtempSync(join(tmpdir(), "lisa-usage-"));
    try {
      const projDir = join(home, "projects", "-Users-x-proj");
      mkdirSync(projDir, { recursive: true });
      const iso = (ms: number) => new Date(ms).toISOString();
      const line = (ms: number, tok: number) =>
        JSON.stringify({ type: "assistant", timestamp: iso(ms), message: { usage: { input_tokens: tok, output_tokens: 0 } } });
      writeFileSync(
        join(projDir, "s.jsonl"),
        [
          JSON.stringify({ type: "user", timestamp: iso(now - 1 * hour) }), // no usage
          line(now - 1 * hour, 100), // in window
          line(now - 4 * hour, 50), // in window (within 5h)
          line(now - 9 * hour, 70), // outside 5h window
        ].join("\n"),
        "utf8",
      );
      const u = readClaudeUsage({ home, nowMs: now });
      assert.ok(u, "expected usage");
      assert.equal(u!.windowTokens, 150);
      assert.equal(u!.windowHours, 5);
      assert.equal(u!.sessions, 1);
      // "today" depends on local midnight; all three usage lines are same UTC day,
      // so todayTokens >= windowTokens.
      assert.ok(u!.todayTokens >= u!.windowTokens);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("absent projects dir → null", () => {
    assert.equal(readClaudeUsage({ home: join(tmpdir(), "nope-" + now()), nowMs: 1 }), null);
  });

  test("planUsage: codex/copilot have no local token log → null", () => {
    assert.equal(planUsage("codex", 1), null);
    assert.equal(planUsage("copilot", 1), null);
  });
});

// tiny non-Date.now nonce for the absent-dir path name
function now(): string {
  return Math.floor(performance.now()).toString(36);
}
