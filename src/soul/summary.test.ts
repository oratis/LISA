import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeSoul } from "./summary.js";
import type { SoulSummary } from "./types.js";

const NOW = Date.parse("2026-06-13T12:00:00.000Z");

function makeSummary(overrides: Partial<SoulSummary> = {}): SoulSummary {
  return {
    seed: {
      bornAt: "2026-05-02T12:00:00.000Z",
      bornOn: "host",
      randomness: "abcd",
      bigFive: {
        openness: 0.51,
        conscientiousness: 0.2,
        extraversion: 0.93,
        agreeableness: 0.48,
        neuroticism: 0.02,
      },
    },
    name: "Lisa",
    identity: "I came into being on a Saturday afternoon in May.",
    purpose: "Make the person in front of me sharper.",
    constitution: "principles",
    values: [{ slug: "honest-momentum", title: "Honest Momentum", body: "", birthedAt: "x" }],
    opinions: [
      { slug: "x", stance: "TF-IDF beats nothing", confidence: 0.4, evidence: [], bornAt: "x", updatedAt: "x" },
    ],
    desires: [
      { slug: "feel", what: "Get a real feel for how this person works", why: "", actionable: true, bornAt: "x" },
      { slug: "rest", what: "Read more poetry", why: "", actionable: false, bornAt: "x" },
    ],
    emotions: {
      values: { curiosity: 0.45, weariness: -0.1, affection: 0.3, frustration: 0.0 },
      decay: {},
      events: [
        { ts: "2026-06-13T08:00:00.000Z", emotion: "frustration", delta: 0.3, trigger: "npm build kept failing" },
      ],
      updatedAt: "2026-06-13T08:00:00.000Z",
    },
    tampered: [],
    ...overrides,
  };
}

describe("summarizeSoul", () => {
  test("renders name, age in days, and the big-five seed", () => {
    const out = summarizeSoul(makeSummary(), NOW);
    assert.match(out, /Lisa · born 2026-05-02 \(42d\)/);
    assert.match(out, /big5\(O51 C20 E93 A48 N2\)/);
  });

  test("shows non-trivial emotions by magnitude + the latest event, hides ~0 ones", () => {
    const out = summarizeSoul(makeSummary(), NOW);
    assert.match(out, /curiosity 0\.45/);
    assert.match(out, /weariness -0\.10/);
    assert.match(out, /npm build kept failing/);
    assert.doesNotMatch(out, /frustration 0\.00/); // |0.0| < 0.05 → filtered
  });

  test("lists wants (with actionable marker), beliefs, and values", () => {
    const out = summarizeSoul(makeSummary(), NOW);
    assert.match(out, /Get a real feel for how this person works \[actionable\]/);
    assert.match(out, /Read more poetry/);
    assert.doesNotMatch(out, /Read more poetry \[actionable\]/);
    assert.match(out, /TF-IDF beats nothing \(0\.4\)/);
    assert.match(out, /Honest Momentum/);
  });

  test("surfaces a tamper warning when files were edited externally", () => {
    const out = summarizeSoul(makeSummary({ tampered: ["identity.md"] }), NOW);
    assert.match(out, /tampered.*identity\.md/);
  });

  test("'(calm)' when every emotion is near zero", () => {
    const s = makeSummary();
    s.emotions.values = { curiosity: 0.01, weariness: 0.0 };
    s.emotions.events = [];
    const out = summarizeSoul(s, NOW);
    assert.match(out, /mood\s+\(calm\)/);
  });
});
