import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MARGIN, costMicroUSD, priceForModel } from "../billing/prices.js";
import {
  MIN_USEFUL_OUTPUT_TOKENS,
  RunCostCap,
  capChargeMicroUSD,
  checkCostCap,
  estimateRoutineMonthlyCost,
  estimateRunCost,
  formatCostEstimate,
  formatRoutineEstimate,
  reservePromptTokens,
} from "./cost.js";

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("estimateRunCost — the same numbers the meter bills", () => {
  const models = [
    "gemini-2.5-flash",
    "glm-4.6",
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "gpt-4o-mini",
    "gpt-4o",
  ];
  for (const model of models) {
    test(`${model}: equals input×in + output×out + cached×cacheRead from the table`, () => {
      const p = priceForModel(model);
      const est = estimateRunCost(model, 120_000, 8_000, 40_000);
      const expected = Math.ceil(
        (120_000 * p.inPerM + 8_000 * p.outPerM + 40_000 * p.cacheReadPerM) / 1_000_000,
      );
      assert.equal(est.microUSD, expected);
      // …and is exactly what settlement would debit for that usage.
      assert.equal(
        est.microUSD,
        costMicroUSD(model, {
          inputTokens: 120_000,
          outputTokens: 8_000,
          cacheReadTokens: 40_000,
          cacheWriteTokens: 0,
        }),
      );
      assert.equal(est.priced, true);
      assert.equal(est.local, false);
      assert.equal(est.basis, "billed");
    });
  }

  test("worked example: Gemini 2.5 Flash, 1M in + 1M out at face value", () => {
    // List $0.30 / $2.50 per M, × 1.4 margin = $0.42 + $3.50.
    assert.equal(estimateRunCost("gemini-2.5-flash", 1_000_000, 1_000_000).microUSD, 3_920_000);
    // Cached prompt tokens are priced at the cache-read rate, not as input.
    assert.equal(estimateRunCost("gemini-2.5-flash", 0, 0, 1_000_000).microUSD, 42_000);
  });

  test("the provider basis removes the margin", () => {
    const billed = estimateRunCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    const provider = estimateRunCost("claude-sonnet-4-6", 1_000_000, 1_000_000, 0, {
      basis: "provider",
    });
    assert.equal(billed.microUSD, 25_200_000); // ($3 + $15) × 1.4
    assert.equal(provider.microUSD, 18_000_000); // $3 + $15
    assert.equal(provider.microUSD, Math.ceil(billed.microUSD / MARGIN));
    assert.equal(provider.basis, "provider");
  });

  test("an unpriced model is quoted at the conservative fallback and flagged", () => {
    const est = estimateRunCost("gemini-2.5-flash-lite", 1_000_000, 0);
    assert.equal(est.priced, false);
    assert.equal(est.microUSD, 4_200_000); // fallback $3/M × 1.4 — an upper bound
    assert.ok(est.microUSD > estimateRunCost("gemini-2.5-flash", 1_000_000, 0).microUSD);
  });

  test("a local model costs nothing", () => {
    const est = estimateRunCost("local://ollama/llama3.2", 1_000_000, 1_000_000);
    assert.deepEqual(est, {
      model: "local://ollama/llama3.2",
      microUSD: 0,
      basis: "billed",
      priced: true,
      local: true,
    });
  });

  test("rounds up, never down", () => {
    // 1 output token of Flash = 3.5 micro-USD → 4.
    assert.equal(estimateRunCost("gemini-2.5-flash", 0, 1).microUSD, 4);
    assert.equal(estimateRunCost("gemini-2.5-flash", 0, 0).microUSD, 0);
  });

  test("rejects counts that are not non-negative finite numbers", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.throws(() => estimateRunCost("gpt-4o", bad, 0), RangeError);
      assert.throws(() => estimateRunCost("gpt-4o", 0, bad), RangeError);
      assert.throws(() => estimateRunCost("gpt-4o", 0, 0, bad), RangeError);
    }
  });
});

describe("formatCostEstimate", () => {
  test("labels never understate", () => {
    assert.equal(formatCostEstimate(0), "$0.00");
    assert.equal(formatCostEstimate(1), "<$0.01");
    assert.equal(formatCostEstimate(9_999), "<$0.01");
    assert.equal(formatCostEstimate(10_000), "~$0.01");
    assert.equal(formatCostEstimate(10_001), "~$0.02"); // rounded up to the cent
    assert.equal(formatCostEstimate(20_000), "~$0.02");
    assert.equal(formatCostEstimate(600_000), "~$0.60");
    assert.equal(formatCostEstimate(12_345_678), "~$12.35");
  });

  test("an unpriced model's figure is shown as an upper bound; local as free", () => {
    assert.equal(formatCostEstimate(estimateRunCost("mystery-model", 100_000, 10_000)), "≤$0.63");
    assert.equal(formatCostEstimate(estimateRunCost("mystery-model", 10, 10)), "≤$0.01");
    assert.equal(
      formatCostEstimate(estimateRunCost("local://llama3.2", 100_000, 10_000)),
      "$0.00 (local model)",
    );
  });

  test("garbage in is labelled, not rendered as a price", () => {
    assert.equal(formatCostEstimate(Number.NaN), "unknown");
    assert.equal(formatCostEstimate(-5), "unknown");
  });
});

describe("estimateRoutineMonthlyCost", () => {
  test("per-run and monthly figures from a token split", () => {
    // A daily digest on Flash: 20k in, 1.5k out, 30 runs a month.
    const est = estimateRoutineMonthlyCost(
      { inputTokens: 20_000, outputTokens: 1_500 },
      30,
      "gemini-2.5-flash",
    );
    // 20k × $0.42/M = 8_400 ; 1.5k × $3.50/M = 5_250 → 13_650 micro-USD
    assert.equal(est.perRun.microUSD, 13_650);
    assert.equal(est.monthlyMicroUSD, 409_500);
    assert.equal(est.runsPerMonth, 30);
    assert.equal(formatRoutineEstimate(est), "~$0.02/run · ~$0.41/month");
  });

  test("cached tokens in the split are priced at the cache-read rate", () => {
    const withCache = estimateRoutineMonthlyCost(
      { inputTokens: 5_000, outputTokens: 1_000, cachedTokens: 15_000 },
      10,
      "claude-sonnet-4-6",
    );
    const p = priceForModel("claude-sonnet-4-6");
    assert.equal(
      withCache.perRun.microUSD,
      Math.ceil((5_000 * p.inPerM + 1_000 * p.outPerM + 15_000 * p.cacheReadPerM) / 1_000_000),
    );
  });

  test("a bare total is priced at the output rate — the safe assumption", () => {
    const bare = estimateRoutineMonthlyCost(10_000, 4, "claude-haiku-4-5");
    assert.equal(bare.perRun.microUSD, estimateRunCost("claude-haiku-4-5", 0, 10_000).microUSD);
    const split = estimateRoutineMonthlyCost(
      { inputTokens: 9_000, outputTokens: 1_000 },
      4,
      "claude-haiku-4-5",
    );
    assert.ok(bare.monthlyMicroUSD > split.monthlyMicroUSD);
  });

  test("fractional run counts round the month up", () => {
    const est = estimateRoutineMonthlyCost({ inputTokens: 1, outputTokens: 1 }, 4.35, "gpt-4o");
    assert.equal(est.monthlyMicroUSD, Math.ceil(est.perRun.microUSD * 4.35));
  });

  test("zero runs, local models, bad input", () => {
    assert.equal(estimateRoutineMonthlyCost(10_000, 0, "gpt-4o").monthlyMicroUSD, 0);
    assert.equal(
      formatRoutineEstimate(estimateRoutineMonthlyCost(10_000, 30, "local://llama3.2")),
      "$0.00 (local model)",
    );
    assert.throws(() => estimateRoutineMonthlyCost(10_000, -1, "gpt-4o"), RangeError);
    assert.throws(() => estimateRoutineMonthlyCost(Number.NaN, 1, "gpt-4o"), RangeError);
  });
});

describe("checkCostCap — decided before the provider call", () => {
  const model = "gemini-2.5-flash"; // in $0.42/M, out $3.50/M, cacheWrite $0.42/M (face)

  test("a fresh run under its cap proceeds with the output ceiling it asked for", () => {
    const verdict = checkCostCap({
      model,
      capMicroUSD: 1_000_000,
      spentMicroUSD: 0,
      nextPromptTokens: 10_000,
      maxTokens: 16_000,
    });
    assert.deepEqual(verdict, { proceed: true, maxTokens: 16_000, spentMicroUSD: 0 });
  });

  test("the output ceiling is clamped to what the cap can still pay for", () => {
    // cap $0.02, prompt reserve 10k × 0.42 = 4_200 → 15_800 left → 4_514 output tokens.
    const verdict = checkCostCap({
      model,
      capMicroUSD: 20_000,
      spentMicroUSD: 0,
      nextPromptTokens: 10_000,
      maxTokens: 16_000,
    });
    assert.deepEqual(verdict, { proceed: true, maxTokens: 4_514, spentMicroUSD: 0 });
    // Worst case of the admitted call fits under the cap.
    const worst = costMicroUSD(model, { ...ZERO, inputTokens: 10_000, outputTokens: 4_514 });
    assert.ok(worst <= 20_000, `worst case ${worst} exceeds the cap`);
  });

  test("stops once the cap is spent", () => {
    const spent = { ...ZERO, inputTokens: 40_000, outputTokens: 2_000 }; // 16_800 + 7_000
    const verdict = checkCostCap({
      model,
      capMicroUSD: 23_800,
      spentMicroUSD: costMicroUSD(model, spent),
      nextPromptTokens: 1,
      maxTokens: 16_000,
    });
    assert.equal(verdict.proceed, false);
    assert.ok(!verdict.proceed && verdict.reason === "cap_reached");
    assert.equal(verdict.spentMicroUSD, 23_800);
  });

  test("stops BEFORE the turn that would cross the cap, not after", () => {
    // 5_000 spent of 10_000; the next prompt alone reserves 42_000.
    const verdict = checkCostCap({
      model,
      capMicroUSD: 10_000,
      spentMicroUSD: costMicroUSD(model, { ...ZERO, outputTokens: 1_428 }), // 4_998
      nextPromptTokens: 100_000,
      maxTokens: 16_000,
    });
    assert.ok(!verdict.proceed && verdict.reason === "next_turn_unaffordable");
    assert.match(!verdict.proceed ? verdict.message : "", /does not fit in what is left/);
  });

  test("stops when what is left cannot buy a useful answer", () => {
    // After the prompt reserve only ~100 output tokens are affordable.
    const cap = 4_200 + Math.ceil((100 * priceForModel(model).outPerM) / 1_000_000);
    const verdict = checkCostCap({
      model,
      capMicroUSD: cap,
      spentMicroUSD: 0,
      nextPromptTokens: 10_000,
      maxTokens: 16_000,
    });
    assert.ok(!verdict.proceed && verdict.reason === "next_turn_unaffordable");
    assert.ok(MIN_USEFUL_OUTPUT_TOKENS > 100);
  });

  test("the prompt is reserved at the dearer of the input and cache-write rates", () => {
    // Anthropic cache writes cost 1.25× input; a prompt that gets cached must fit too.
    const sonnet = priceForModel("claude-sonnet-4-6");
    assert.ok(sonnet.cacheWritePerM > sonnet.inPerM);
    const promptTokens = 100_000;
    const reserveAtInput = (promptTokens * sonnet.inPerM) / 1_000_000;
    const reserveAtWrite = (promptTokens * sonnet.cacheWritePerM) / 1_000_000;
    // A cap that covers the prompt at the input rate plus 1k output tokens, but
    // not at the cache-write rate.
    const cap = Math.ceil(reserveAtInput + (1_000 * sonnet.outPerM) / 1_000_000);
    assert.ok(cap < reserveAtWrite + (MIN_USEFUL_OUTPUT_TOKENS * sonnet.outPerM) / 1_000_000);
    const verdict = checkCostCap({
      model: "claude-sonnet-4-6",
      capMicroUSD: cap,
      spentMicroUSD: 0,
      nextPromptTokens: promptTokens,
      maxTokens: 16_000,
    });
    assert.ok(!verdict.proceed && verdict.reason === "next_turn_unaffordable");
  });

  test("an unpriced model is reserved at the conservative fallback rate", () => {
    const known = checkCostCap({
      model: "gemini-2.5-flash",
      capMicroUSD: 100_000,
      spentMicroUSD: 0,
      nextPromptTokens: 10_000,
      maxTokens: 1_000_000,
    });
    const unknown = checkCostCap({
      model: "some-unlisted-model",
      capMicroUSD: 100_000,
      spentMicroUSD: 0,
      nextPromptTokens: 10_000,
      maxTokens: 1_000_000,
    });
    assert.ok(known.proceed && unknown.proceed);
    assert.ok(unknown.maxTokens < known.maxTokens);
  });

  describe("never fails open", () => {
    for (const cap of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined as unknown as number,
      "5" as unknown as number,
      null as unknown as number,
    ]) {
      test(`a cap of ${String(cap)} stops the run`, () => {
        const verdict = checkCostCap({
          model,
          capMicroUSD: cap,
          spentMicroUSD: 0,
          nextPromptTokens: 1,
          maxTokens: 16_000,
        });
        assert.ok(!verdict.proceed && verdict.reason === "invalid_cap");
      });
    }

    test("unreadable usage stops the run instead of counting as zero spend", () => {
      for (const bad of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        undefined as unknown as number,
      ]) {
        const charge = capChargeMicroUSD({
          model,
          usage: { ...ZERO, inputTokens: 10, outputTokens: bad },
          promptBytes: 40,
          outputBytes: 4,
          reservedPromptTokens: 14,
          maxTokens: 1_000,
        });
        assert.ok(Number.isNaN(charge), String(bad));
        const verdict = checkCostCap({
          model,
          capMicroUSD: 1_000_000,
          spentMicroUSD: 500 + charge,
          nextPromptTokens: 1,
          maxTokens: 16_000,
        });
        assert.ok(!verdict.proceed && verdict.reason === "usage_unreadable", String(bad));
      }
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, null as unknown as number]) {
        const verdict = checkCostCap({
          model,
          capMicroUSD: 1_000_000,
          spentMicroUSD: bad,
          nextPromptTokens: 1,
          maxTokens: 16_000,
        });
        assert.ok(!verdict.proceed && verdict.reason === "usage_unreadable", String(bad));
      }
    });

    test("an unknown prompt size stops the run", () => {
      const verdict = checkCostCap({
        model,
        capMicroUSD: 1_000_000,
        spentMicroUSD: 0,
        nextPromptTokens: Number.NaN,
        maxTokens: 16_000,
      });
      assert.ok(!verdict.proceed && verdict.reason === "next_turn_unaffordable");
    });

    test("a missing output ceiling is replaced by the affordable one, not by 'unlimited'", () => {
      for (const maxTokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const verdict = checkCostCap({
          model,
          capMicroUSD: 20_000,
          spentMicroUSD: 0,
          nextPromptTokens: 10_000,
          maxTokens,
        });
        assert.ok(verdict.proceed);
        assert.equal(verdict.proceed && verdict.maxTokens, 4_514);
      }
    });
  });
});

describe("capChargeMicroUSD — what one call counts against the cap", () => {
  const model = "gpt-4o"; // face: in $3.50/M, out $14/M
  const call = {
    model,
    promptBytes: 4_000,
    outputBytes: 400,
    reservedPromptTokens: 1_334,
    maxTokens: 2_000,
  };

  test("reported usage is priced as reported", () => {
    const usage = { ...ZERO, inputTokens: 1_000, outputTokens: 80 };
    assert.equal(capChargeMicroUSD({ ...call, usage }), costMicroUSD(model, usage));
  });

  test("usage of all zeros is not free: the call is charged what it was admitted with", () => {
    // The prompt reservation and the whole output ceiling — output the
    // provider did not count may be thinking that never shows in the bytes.
    assert.equal(
      capChargeMicroUSD({ ...call, usage: ZERO }),
      costMicroUSD(model, { ...ZERO, inputTokens: 1_334, outputTokens: 2_000 }),
    );
    // Never less than the gateway's byte floor (#264) for what was sent and
    // returned, e.g. when the provider ignored the ceiling.
    assert.equal(
      capChargeMicroUSD({ ...call, usage: ZERO, outputBytes: 40_000, reservedPromptTokens: 0 }),
      costMicroUSD(model, { ...ZERO, inputTokens: 1_000, outputTokens: 10_000 }),
    );
  });

  test("a zero on one side only is filled in on that side", () => {
    // Output but zero output tokens: impossible, so the output was not counted.
    assert.equal(
      capChargeMicroUSD({ ...call, usage: { ...ZERO, inputTokens: 900 } }),
      costMicroUSD(model, { ...ZERO, inputTokens: 900, outputTokens: 2_000 }),
    );
    // Output counted but no prompt tokens: the prompt was not counted.
    assert.equal(
      capChargeMicroUSD({ ...call, usage: { ...ZERO, outputTokens: 50 } }),
      costMicroUSD(model, { ...ZERO, inputTokens: 1_334, outputTokens: 50 }),
    );
    // A prompt served from the cache counts as a reported prompt.
    assert.equal(
      capChargeMicroUSD({ ...call, usage: { ...ZERO, cacheReadTokens: 900, outputTokens: 50 } }),
      costMicroUSD(model, { ...ZERO, cacheReadTokens: 900, outputTokens: 50 }),
    );
  });

  test("an empty answer with a reported prompt is believed", () => {
    const usage = { ...ZERO, inputTokens: 900 };
    assert.equal(capChargeMicroUSD({ ...call, usage, outputBytes: 0 }), costMicroUSD(model, usage));
  });
});

describe("RunCostCap — admit before each call, charge after it", () => {
  test("a provider that never reports usage still exhausts the cap", () => {
    // gpt-4o, $0.05 cap. The probe that found this ran 32 calls to 31× the cap.
    const cap = new RunCostCap(50_000, "gpt-4o");
    let calls = 0;
    let trueSpend = 0;
    for (;;) {
      const promptBytes = 300 + 150 * calls;
      const verdict = cap.admit({ promptBytes, maxTokens: 16_000 });
      if (!verdict.proceed) break;
      calls++;
      // Worst case the provider may really have billed: the prompt at four
      // bytes a token and every output token it was allowed.
      trueSpend += costMicroUSD("gpt-4o", {
        ...ZERO,
        inputTokens: Math.ceil(promptBytes / 4),
        outputTokens: verdict.maxTokens,
      });
      cap.charge({ usage: ZERO, output: [{ type: "tool_use" }] });
    }
    assert.ok(calls >= 1);
    assert.ok(trueSpend <= 50_000, `true spend ${trueSpend} over ${calls} calls`);
  });

  test("the previous call's real prompt is a floor under the next reservation", () => {
    const cap = new RunCostCap(1_000_000, "gemini-2.5-flash");
    assert.ok(cap.admit({ promptBytes: 300, maxTokens: 16_000 }).proceed);
    cap.charge({ usage: { ...ZERO, inputTokens: 90_000, outputTokens: 10 }, output: ["x"] });
    // 300 bytes would reserve 100 tokens; the provider just counted 90k.
    const verdict = cap.admit({ promptBytes: 300, maxTokens: 1_000_000 });
    assert.ok(verdict.proceed);
    const spent = cap.spentMicroUSD;
    const promptReserve = Math.ceil((90_000 * priceForModel("gemini-2.5-flash").inPerM) / 1e6);
    assert.equal(
      verdict.maxTokens,
      Math.floor(
        ((1_000_000 - spent - promptReserve) * 1e6) / priceForModel("gemini-2.5-flash").outPerM,
      ),
    );
  });

  test("unreadable usage makes the next admit stop", () => {
    const cap = new RunCostCap(1_000_000, "gemini-2.5-flash");
    assert.ok(cap.admit({ promptBytes: 300, maxTokens: 16_000 }).proceed);
    cap.charge({ usage: { ...ZERO, inputTokens: Number.NaN }, output: [] });
    const verdict = cap.admit({ promptBytes: 300, maxTokens: 16_000 });
    assert.ok(!verdict.proceed && verdict.reason === "usage_unreadable");
  });
});

describe("reservePromptTokens", () => {
  test("three bytes per token, rounded up; nothing for nothing", () => {
    assert.equal(reservePromptTokens(0), 0);
    assert.equal(reservePromptTokens(1), 1);
    assert.equal(reservePromptTokens(3), 1);
    assert.equal(reservePromptTokens(4), 2);
    assert.equal(reservePromptTokens(3_000), 1_000);
    assert.equal(reservePromptTokens(Number.NaN), 0);
  });
});
