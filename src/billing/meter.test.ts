import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-billing-"));
process.env.LISA_HOME = TMP;

const { homeScope, homeForUid } = await import("../paths.js");
const { recordUsage, readUsage, summarizeUsage, claimAnomalyAlert, priceTurn, sumUsage } =
  await import("./meter.js");
const {
  costMicroUSD,
  priceForModel,
  explicitPriceForModel,
  modelTier,
  formatMicroUSD,
  MARGIN,
  tokensAffordable,
} = await import("./prices.js");

const U = (i: number, o: number, cr = 0, cw = 0) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: cr,
  cacheWriteTokens: cw,
});

describe("prices", () => {
  test("only the verified Gemini Flash model uses standard pricing", () => {
    assert.equal(modelTier("gemini-2.5-flash"), "standard");
    for (const model of [
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-image",
      "gemini-2.5-flash-preview",
      "gemini-2.5-pro",
    ]) {
      assert.equal(modelTier(model), "premium");
    }
    assert.equal(
      costMicroUSD("gemini-2.5-flash", U(1_000_000, 1_000_000, 1_000_000)),
      Math.round((0.3 + 2.5 + 0.03) * MARGIN * 1e6),
    );
  });

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

  test("current Claude models carry their 2026-11 list prices and tiers", () => {
    // claude.com/pricing, verified 2026-11-07: Sonnet 5.5 $2/$10, Opus 5.5 cache read $0.20.
    assert.equal(
      costMicroUSD("claude-sonnet-5-5", U(1_000_000, 1_000_000)),
      Math.round((2 + 10) * MARGIN * 1e6),
    );
    assert.equal(
      costMicroUSD("claude-opus-5-5", U(0, 0, 1_000_000)),
      Math.round(0.2 * MARGIN * 1e6),
    );
    assert.equal(modelTier("claude-haiku-5-5"), "standard");
    assert.equal(modelTier("gpt-6-luna"), "standard");
    for (const model of [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "gpt-6.1-sol",
    ]) {
      assert.equal(modelTier(model), "premium", model);
    }
  });

  test("Claude Haiku 5.5 bills a whole request at the long-context rate above 100K prompt tokens", () => {
    // ≤100K: $0.10 in / $0.50 out; above: $0.50 / $2.50 — face = list × MARGIN.
    assert.equal(
      costMicroUSD("claude-haiku-5-5", U(100_000, 1_000)),
      Math.ceil((100_000 * 0.1 + 1_000 * 0.5) * MARGIN),
    );
    assert.equal(
      costMicroUSD("claude-haiku-5-5", U(100_001, 1_000)),
      Math.ceil((100_001 * 0.5 + 1_000 * 2.5) * MARGIN),
    );
    // Cached prompt tokens count toward the threshold.
    assert.equal(
      costMicroUSD("claude-haiku-5-5", U(60_000, 0, 50_000)),
      Math.ceil((60_000 * 0.5 + 50_000 * 0.05) * MARGIN),
    );
    // The per-turn breaker assumes the dearer rate.
    assert.equal(tokensAffordable("claude-haiku-5-5", 50_000), Math.floor(50_000 / (2.5 * MARGIN)));
  });

  test("Sonnet 5.5 reads cache at its $0.20 list rate, like Opus 5.5 (#447 review)", () => {
    assert.equal(
      costMicroUSD("claude-sonnet-5-5", U(0, 0, 1_000_000)),
      Math.round(0.2 * MARGIN * 1e6),
    );
  });

  test("1-hour cache writes bill at 2x input, 5-minute writes at 1.25x (#447 review)", () => {
    const write = (total: number, oneHour?: number) =>
      costMicroUSD("claude-haiku-5-5", {
        ...U(0, 0, 0, total),
        ...(oneHour === undefined ? {} : { cacheWrite1hTokens: oneHour }),
      });
    // Haiku 5.5 below its 100K long-context threshold: $0.10 input.
    assert.equal(write(50_000), Math.ceil(50_000 * 0.125 * MARGIN));
    assert.equal(write(50_000, 50_000), Math.ceil(50_000 * 0.2 * MARGIN));
    assert.equal(write(50_000, 20_000), Math.ceil((30_000 * 0.125 + 20_000 * 0.2) * MARGIN));
    // A 1-hour count above the total is held to the total; a bad one is ignored.
    assert.equal(write(1_000, 5_000), write(1_000, 1_000));
    assert.equal(write(1_000, Number.NaN), write(1_000));
    // Every Anthropic row carries the 1-hour rate.
    for (const model of ["claude-opus-5-5", "claude-sonnet-4-6", "claude-future-9"]) {
      const p = priceForModel(model);
      assert.equal(p.cacheWrite1hPerM, p.inPerM * 2, model);
    }
    // Providers with one write rate are unchanged by a 1-hour count.
    assert.equal(
      costMicroUSD("gpt-6-luna", { ...U(0, 0, 0, 1_000), cacheWrite1hTokens: 1_000 }),
      costMicroUSD("gpt-6-luna", U(0, 0, 0, 1_000)),
    );
  });

  test("OpenAI models bill a prompt above 272K tokens at their long-context rates (#447 review)", () => {
    // gpt-6-luna: $0.10 / $0.50 up to 272K, $0.20 / $0.75 above.
    assert.equal(
      costMicroUSD("gpt-6-luna", U(272_000, 1_000)),
      Math.ceil((272_000 * 0.1 + 1_000 * 0.5) * MARGIN),
    );
    assert.equal(
      costMicroUSD("gpt-6-luna", U(272_001, 1_000)),
      Math.ceil((272_001 * 0.2 + 1_000 * 0.75) * MARGIN),
    );
    for (const [model, input, cached] of [
      ["gpt-5.5", 10, 1],
      ["gpt-6.1-sol", 4, 0.2],
      ["gpt-6.1-terra", 2, 0.1],
      ["gpt-6-astra", 20, 2],
    ] as const) {
      assert.equal(
        costMicroUSD(model, U(200_000, 0, 100_000)),
        Math.ceil((200_000 * input + 100_000 * cached) * MARGIN),
        model,
      );
    }
  });

  test("OpenAI pro models are priced at their own rates, a new pro id at the dearest (#447 review)", () => {
    const out = (model: string) => costMicroUSD(model, U(0, 1_000_000));
    assert.equal(out("gpt-5.5-pro"), Math.round(180 * MARGIN * 1e6));
    assert.equal(out("gpt-5.4-pro"), Math.round(180 * MARGIN * 1e6));
    assert.equal(out("gpt-5.2-pro"), Math.round(168 * MARGIN * 1e6));
    assert.equal(out("gpt-5-pro"), Math.round(120 * MARGIN * 1e6));
    assert.equal(out("o3-pro"), Math.round(80 * MARGIN * 1e6));
    for (const model of ["gpt-5.5-pro-2026-10-01", "gpt-7-pro", "o4-pro", "o1-pro"]) {
      assert.equal(out(model), Math.round(180 * MARGIN * 1e6), model);
      assert.equal(modelTier(model), "premium", model);
    }
    // A pro list price has no cached-input discount.
    assert.equal(
      costMicroUSD("gpt-5.5-pro", U(0, 0, 1_000_000)),
      costMicroUSD("gpt-5.5-pro", U(1_000_000, 0)),
    );
    // The pro catch-all is OpenAI-only: Gemini Pro stays without a verified row.
    assert.equal(explicitPriceForModel("gemini-2.5-pro"), null);
    assert.equal(priceForModel("gpt-5.5").outPerM, Math.round(30 * MARGIN * 1e6));
  });

  test("a new id under a known vendor is never priced below that vendor's dearest model", () => {
    assert.ok(priceForModel("gpt-7-future").outPerM >= priceForModel("gpt-6-astra").outPerM);
    // Long prompts too: the generic GPT row carries the dearest long-context rate.
    assert.ok(
      costMicroUSD("gpt-7-future", U(300_000, 10_000)) >=
        costMicroUSD("gpt-6-astra", U(300_000, 10_000)),
    );
    assert.ok(
      costMicroUSD("mystery-9000", U(300_000, 10_000)) >=
        costMicroUSD("gpt-6-astra", U(300_000, 10_000)),
    );
    assert.ok(
      priceForModel("claude-future-9").outPerM >= priceForModel("claude-fable-5-1").outPerM,
    );
    // Unlisted GLM ids are priced like the flagship and kept off the free allowance.
    assert.equal(modelTier("glm-5.3"), "premium");
    assert.equal(modelTier("glm-5.3-flash"), "standard");
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

describe("per-call turn pricing (#447 review)", () => {
  test("a multi-call turn is priced call by call, so long-context rates apply per request", () => {
    const calls = [U(60_000, 100), U(2_000, 50, 58_000), U(1_000, 80, 61_000)];
    const total = sumUsage(calls);
    assert.deepEqual(total, U(63_000, 230, 119_000));
    const perCall = calls.reduce((sum, c) => sum + costMicroUSD("claude-haiku-5-5", c), 0);
    assert.equal(priceTurn("claude-haiku-5-5", total, calls), perCall);
    // Priced as one 182K-token request, the same turn would cost 5× as much.
    assert.equal(priceTurn("claude-haiku-5-5", total), costMicroUSD("claude-haiku-5-5", total));
    assert.ok(priceTurn("claude-haiku-5-5", total) > 4 * perCall);
  });

  test("the 1-hour write share adds up, and the audit line carries it", async () => {
    const calls = [
      { ...U(10, 1, 0, 100), cacheWrite1hTokens: 60 },
      { ...U(10, 1, 0, 50), cacheWrite1hTokens: 50 },
      U(10, 1),
    ];
    assert.equal(sumUsage(calls).cacheWrite1hTokens, 110);
    assert.equal("cacheWrite1hTokens" in sumUsage([U(1, 1)]), false);
    // Its own home, so the ledger tests below see none of this line.
    const rec = await homeScope.run(homeForUid("em-pricecalls"), () =>
      recordUsage("chat", "claude-haiku-5-5", sumUsage(calls), new Date(), { calls }),
    );
    assert.equal(rec.cacheWrite1hTokens, 110);
    assert.equal(rec.microUSD, priceTurn("claude-haiku-5-5", sumUsage(calls), calls));
  });
});

describe("meter ledger", () => {
  test("record → read → summarize round-trip", async () => {
    const rec = await recordUsage(
      "chat",
      "glm-4.6",
      U(1000, 2000),
      new Date("2026-07-22T10:00:00Z"),
    );
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

describe("anomaly alert claim (cross-instance dedup)", () => {
  // The claim is what stops MAX_INSTANCES>1 from paging the operator once per
  // instance for the same $10 day. Its contract is asymmetric on purpose:
  // only a precondition failure is treated as "someone else has it".
  const DAY = "2026-08-21";
  const uid = "u-anomaly-1";

  const withFirestore = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = {
      on: process.env.LISA_FIRESTORE,
      tok: process.env.LISA_FIRESTORE_TOKEN,
      proj: process.env.LISA_FIRESTORE_PROJECT,
    };
    process.env.LISA_FIRESTORE = "1";
    process.env.LISA_FIRESTORE_TOKEN = "test-token";
    process.env.LISA_FIRESTORE_PROJECT = "test-project";
    try {
      return await fn();
    } finally {
      if (prev.on === undefined) delete process.env.LISA_FIRESTORE;
      else process.env.LISA_FIRESTORE = prev.on;
      if (prev.tok === undefined) delete process.env.LISA_FIRESTORE_TOKEN;
      else process.env.LISA_FIRESTORE_TOKEN = prev.tok;
      if (prev.proj === undefined) delete process.env.LISA_FIRESTORE_PROJECT;
      else process.env.LISA_FIRESTORE_PROJECT = prev.proj;
    }
  };

  const reply =
    (status: number): typeof fetch =>
    async () =>
      new Response(status === 200 ? "{}" : "denied", { status });

  test("Firestore off → always claims (Mac edition keeps the in-process Set)", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(await claimAnomalyAlert(DAY, spy), true);
    assert.equal(called, false, "must not touch the network when Firestore is off");
  });

  test("Firestore on but no uid scope → claims without a write", async () => {
    await withFirestore(async () => {
      let called = false;
      const spy = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      assert.equal(await claimAnomalyAlert(DAY, spy), true);
      assert.equal(called, false);
    });
  });

  test("create succeeds → this instance owns the alert", async () => {
    await withFirestore(async () => {
      await homeScope.run(homeForUid(uid), async () => {
        assert.equal(await claimAnomalyAlert(DAY, reply(200)), true);
      });
    });
  });

  for (const status of [409, 412]) {
    test(`precondition failure ${status} → another instance already alerted`, async () => {
      await withFirestore(async () => {
        await homeScope.run(homeForUid(uid), async () => {
          assert.equal(await claimAnomalyAlert(DAY, reply(status)), false);
        });
      });
    });
  }

  test("Firestore unavailable → still alerts (a missed burn beats a duplicate)", async () => {
    await withFirestore(async () => {
      await homeScope.run(homeForUid(uid), async () => {
        assert.equal(await claimAnomalyAlert(DAY, reply(503)), true);
        const boom = (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch;
        assert.equal(await claimAnomalyAlert(DAY, boom), true);
      });
    });
  });
});
