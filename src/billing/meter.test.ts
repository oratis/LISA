import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-billing-"));
process.env.LISA_HOME = TMP;

const { homeScope, homeForUid } = await import("../paths.js");
const { recordUsage, readUsage, summarizeUsage } = await import("./meter.js");
const { costMicroUSD, priceForModel, modelTier, formatMicroUSD, MARGIN } = await import("./prices.js");

const U = (i: number, o: number, cr = 0, cw = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: cr,
  cacheWriteTokens: cw,
});

describe("prices", () => {
  test("glm is standard tier; claude/gpt/unknown are premium", () => {
    assert.equal(modelTier("glm-4.6"), "standard");
    assert.equal(modelTier("claude-sonnet-4-6"), "premium");
    assert.equal(modelTier("gpt-4o"), "premium");
    assert.equal(modelTier("totally-unknown-model"), "premium");
  });

  test("cost math: face = list × margin, exact micro-USD", () => {
    // 1M output tokens of glm-4.6 at $2.2 list × 1.4 margin = $3.08 face.
    assert.equal(costMicroUSD("glm-4.6", U(0, 1_000_000)), Math.round(2.2 * MARGIN * 1e6));
    // Zero usage costs zero; tiny usage rounds UP (never free).
    assert.equal(costMicroUSD("glm-4.6", U(0, 0)), 0);
    assert.equal(costMicroUSD("glm-4.6", U(1, 0)) >= 1, true);
  });

  test("unknown model gets the conservative fallback, not free", () => {
    const p = priceForModel("mystery-9000");
    assert.equal(p.tier, "premium");
    assert.ok(p.outPerM > 0);
  });

  test("formatMicroUSD renders dollars", () => {
    assert.equal(formatMicroUSD(3_080_000), "$3.08");
  });
});

describe("meter ledger", () => {
  test("record → read → summarize round-trip", async () => {
    const rec = await recordUsage("chat", "glm-4.6", U(1000, 2000), new Date("2026-07-22T10:00:00Z"));
    assert.ok(rec);
    assert.equal(rec.model, "glm-4.6");
    assert.ok(rec.microUSD > 0);
    const rows = await readUsage();
    assert.equal(rows.length, 1);
    const sum = await summarizeUsage(Date.parse("2026-07-22T00:00:00Z"));
    assert.equal(sum.turns, 1);
    assert.equal(sum.microUSD, rec.microUSD);
    assert.equal(sum.inputTokens, 1000);
    // A window starting after the record excludes it.
    const later = await summarizeUsage(Date.parse("2026-07-23T00:00:00Z"));
    assert.equal(later.turns, 0);
  });

  test("ledger is per-home: a scoped uid writes into its own subtree", async () => {
    const HOME_A = homeForUid("em-metertest");
    await homeScope.run(HOME_A, async () => {
      await recordUsage("chat", "glm-4.6", U(10, 10));
      const scoped = await readUsage();
      assert.equal(scoped.length, 1);
    });
    assert.ok(fs.existsSync(path.join(HOME_A, "billing", "usage.jsonl")));
    // The global ledger from the previous test still has exactly one row.
    const globalRows = await readUsage();
    assert.equal(globalRows.length, 1);
  });

  test("a failed audit append still returns a priced record (#264)", async () => {
    // A turn whose ledger line can't land must NOT come back unpriced — the
    // caller debits `microUSD`, so a null/zero here ships free inference.
    const HOME_B = homeForUid("em-appendfail");
    fs.mkdirSync(path.join(HOME_B, "billing", "usage.jsonl"), { recursive: true }); // append → EISDIR
    await homeScope.run(HOME_B, async () => {
      const rec = await recordUsage("chat", "glm-4.6", U(1000, 2000));
      assert.ok(rec, "recordUsage must not return null when the append fails");
      assert.ok(rec.microUSD > 0);
      assert.equal(rec.microUSD, costMicroUSD("glm-4.6", U(1000, 2000)));
    });
  });

  test("corrupt lines are skipped, not fatal", async () => {
    fs.appendFileSync(path.join(TMP, "billing", "usage.jsonl"), "not-json\n");
    const rows = await readUsage();
    assert.equal(rows.length, 1);
  });
});
