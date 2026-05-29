import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decayEmotions } from "./store.js";
import type { EmotionState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function stateAt(iso: string, values: Record<string, number>, decay: Record<string, number>): EmotionState {
  return { values, decay, events: [{ ts: iso, emotion: "x", delta: 0, trigger: "seed" }], updatedAt: iso };
}

describe("decayEmotions — exponential decay math", () => {
  test("zero elapsed time is a no-op", () => {
    const t = "2026-05-28T00:00:00.000Z";
    const s = stateAt(t, { curiosity: 0.6 }, { curiosity: 0.05 });
    const out = decayEmotions(s, Date.parse(t));
    assert.equal(out, s, "same reference returned when days === 0");
  });

  test("decays toward zero by exp(-rate * days)", () => {
    const t0 = "2026-05-01T00:00:00.000Z";
    const start = Date.parse(t0);
    const s = stateAt(t0, { curiosity: 0.6 }, { curiosity: 0.05 });
    // 14 days later, rate 0.05/day → 0.6 * e^(-0.7) ≈ 0.298
    const out = decayEmotions(s, start + 14 * DAY_MS);
    assert.ok(Math.abs(out.values.curiosity! - 0.6 * Math.exp(-0.7)) < 1e-9);
  });

  test("half-life check: value halves after ln2/rate days", () => {
    const t0 = "2026-05-01T00:00:00.000Z";
    const start = Date.parse(t0);
    const rate = 0.1;
    const halfLifeDays = Math.LN2 / rate; // ~6.93 days
    const s = stateAt(t0, { weariness: 1.0 }, { weariness: rate });
    const out = decayEmotions(s, start + halfLifeDays * DAY_MS);
    assert.ok(Math.abs(out.values.weariness! - 0.5) < 1e-9);
  });

  test("missing decay rate falls back to 0.1/day", () => {
    const t0 = "2026-05-01T00:00:00.000Z";
    const start = Date.parse(t0);
    const s = stateAt(t0, { mystery: 0.8 }, {}); // no rate for "mystery"
    const out = decayEmotions(s, start + 1 * DAY_MS);
    assert.ok(Math.abs(out.values.mystery! - 0.8 * Math.exp(-0.1)) < 1e-9);
  });

  test("negative intensities decay toward zero too", () => {
    const t0 = "2026-05-01T00:00:00.000Z";
    const start = Date.parse(t0);
    const s = stateAt(t0, { frustration: -0.4 }, { frustration: 0.4 });
    const out = decayEmotions(s, start + 2 * DAY_MS);
    const expected = -0.4 * Math.exp(-0.8);
    assert.ok(Math.abs(out.values.frustration! - expected) < 1e-9);
    assert.ok(out.values.frustration! > -0.4, "moved toward zero");
  });
});

describe("decayEmotions — preserves trail + rates (the events-drop bug)", () => {
  test("events array is preserved through decay", () => {
    const t0 = "2026-05-01T00:00:00.000Z";
    const start = Date.parse(t0);
    const s: EmotionState = {
      values: { curiosity: 0.6 },
      decay: { curiosity: 0.05 },
      events: [
        { ts: t0, emotion: "curiosity", delta: 0.3, trigger: "a surprising question" },
        { ts: t0, emotion: "curiosity", delta: 0.1, trigger: "another one" },
      ],
      updatedAt: t0,
    };
    const out = decayEmotions(s, start + 5 * DAY_MS);
    assert.equal(out.events?.length, 2, "events must survive decay");
    assert.equal(out.events?.[0]?.trigger, "a surprising question");
    assert.deepEqual(out.decay, s.decay, "decay rates preserved");
  });
});

describe("decayEmotions — continuity (the soul_feel-on-stale-value bug)", () => {
  test("decay-then-add ≠ add-onto-stale after a long gap", () => {
    // Reproduces the fix: curiosity 0.6 a week ago (rate 0.05) should decay to
    // ~0.42 before a +0.2 feel, giving ~0.62 — NOT 0.6 + 0.2 = 0.8.
    const t0 = "2026-05-01T00:00:00.000Z";
    const start = Date.parse(t0);
    const s = stateAt(t0, { curiosity: 0.6 }, { curiosity: 0.05 });
    const decayed = decayEmotions(s, start + 7 * DAY_MS);
    const baseline = decayed.values.curiosity!;
    assert.ok(baseline < 0.6, "baseline decayed below the stored 0.6");
    const afterFeel = baseline + 0.2;
    assert.ok(afterFeel < 0.8, "decay-then-add stays below the naive stale-add result");
    assert.ok(Math.abs(baseline - 0.6 * Math.exp(-0.35)) < 1e-9);
  });
});
