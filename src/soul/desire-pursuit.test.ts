import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAutoPursuable, needsUserHelp } from "./store.js";
import { summarizeSoul } from "./summary.js";
import type { DesireEntry, SoulSummary } from "./types.js";

function desire(over: Partial<DesireEntry> = {}): DesireEntry {
  return {
    slug: "d",
    what: "do a thing",
    why: "because",
    actionable: true,
    heartbeatPrompt: "pursue it",
    bornAt: "2026-01-01",
    ...over,
  };
}

describe("isAutoPursuable (R4)", () => {
  test("actionable + heartbeatPrompt, self/undefined pursuit → true", () => {
    assert.equal(isAutoPursuable(desire()), true);
    assert.equal(isAutoPursuable(desire({ pursuit: "self" })), true);
  });
  test("needs-user → false (not auto-spun by the heartbeat)", () => {
    assert.equal(isAutoPursuable(desire({ pursuit: "needs-user" })), false);
  });
  test("non-actionable or missing heartbeatPrompt → false", () => {
    assert.equal(isAutoPursuable(desire({ actionable: false })), false);
    assert.equal(isAutoPursuable(desire({ heartbeatPrompt: undefined })), false);
  });
});

describe("needsUserHelp (R4)", () => {
  test("actionable + needs-user → true", () => {
    assert.equal(needsUserHelp(desire({ pursuit: "needs-user" })), true);
  });
  test("self / non-actionable → false", () => {
    assert.equal(needsUserHelp(desire({ pursuit: "self" })), false);
    assert.equal(needsUserHelp(desire({ actionable: false, pursuit: "needs-user" })), false);
  });
});

function summaryWith(desires: DesireEntry[]): SoulSummary {
  return {
    seed: {
      bornAt: "2026-05-02T12:00:00.000Z",
      bornOn: "h",
      randomness: "ab",
      bigFive: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
    },
    name: "Lisa",
    identity: "i",
    purpose: "p",
    constitution: "c",
    values: [],
    opinions: [],
    desires,
    emotions: { values: {}, decay: {}, events: [], updatedAt: "2026-06-13T00:00:00.000Z" },
    tampered: [],
  };
}

describe("summarizeSoul — desire markers (R4)", () => {
  test("needs-user → [needs you]; self → [actionable]; non-actionable → no tag", () => {
    const out = summarizeSoul(
      summaryWith([
        desire({ slug: "a", what: "auto thing", pursuit: "self" }),
        desire({ slug: "b", what: "needs help thing", pursuit: "needs-user" }),
        desire({ slug: "c", what: "idle wish", actionable: false }),
      ]),
      Date.parse("2026-06-13T12:00:00.000Z"),
    );
    assert.match(out, /auto thing \[actionable\]/);
    assert.match(out, /needs help thing \[needs you\]/);
    assert.match(out, /• idle wish$/m); // no tag
  });
});
