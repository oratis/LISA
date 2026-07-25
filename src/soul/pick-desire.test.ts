import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveDesireIntensity,
  isDesireReviewDue,
  pickCurrentDesire,
} from "./store.js";
import type { DesireEntry } from "./types.js";

// PLAN_DESIRE_EVOLUTION_v1.0 §3 PR3: the surfaced "current desire" must track
// real activity, not fs.readdir order. pickCurrentDesire is the pure core.

function d(slug: string, over: Partial<DesireEntry> = {}): DesireEntry {
  return {
    slug,
    what: slug,
    why: "",
    actionable: false,
    bornAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("pickCurrentDesire", () => {
  test("returns null for an empty list", () => {
    assert.equal(pickCurrentDesire([]), null);
  });

  test("prefers actionable desires over dormant ones", () => {
    const desires = [
      d("dormant-newer", { bornAt: "2026-06-01T00:00:00.000Z" }),
      d("actionable-older", { actionable: true, bornAt: "2026-02-01T00:00:00.000Z" }),
    ];
    // Even though the dormant one is newer, an actionable one is what she's
    // actually pursuing, so it wins.
    assert.equal(pickCurrentDesire(desires)?.slug, "actionable-older");
  });

  test("among actionable, the most recently active wins (via activity map)", () => {
    const desires = [
      d("a", { actionable: true, bornAt: "2026-01-01T00:00:00.000Z" }),
      d("b", { actionable: true, bornAt: "2026-01-01T00:00:00.000Z" }),
      d("c", { actionable: true, bornAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const activityAt = {
      a: "2026-03-01T00:00:00.000Z",
      b: "2026-09-01T00:00:00.000Z", // most recently pursued
      c: "2026-05-01T00:00:00.000Z",
    };
    assert.equal(pickCurrentDesire(desires, activityAt)?.slug, "b");
  });

  test("is independent of array (fs.readdir) order", () => {
    const a = d("a", { actionable: true, bornAt: "2026-01-01T00:00:00.000Z" });
    const b = d("b", { actionable: true, bornAt: "2026-08-01T00:00:00.000Z" });
    // Newer 'b' is picked regardless of whether it's listed first or last.
    assert.equal(pickCurrentDesire([a, b])?.slug, "b");
    assert.equal(pickCurrentDesire([b, a])?.slug, "b");
  });

  test("falls back to bornAt when a slug has no activity entry", () => {
    const desires = [
      d("old", { actionable: true, bornAt: "2026-01-01T00:00:00.000Z" }),
      d("new", { actionable: true, bornAt: "2026-07-01T00:00:00.000Z" }),
    ];
    // Empty activity map → ordering purely by bornAt.
    assert.equal(pickCurrentDesire(desires, {})?.slug, "new");
  });

  test("activity recency beats a younger bornAt (pursuit refreshes an old desire)", () => {
    const desires = [
      d("young-idle", { actionable: true, bornAt: "2026-06-01T00:00:00.000Z" }),
      d("old-but-pursued", { actionable: true, bornAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const activityAt = {
      "old-but-pursued": "2026-09-01T00:00:00.000Z", // pursued yesterday
    };
    assert.equal(pickCurrentDesire(desires, activityAt)?.slug, "old-but-pursued");
  });

  test("with no actionable desires, picks the most recent of all", () => {
    const desires = [
      d("x", { bornAt: "2026-01-01T00:00:00.000Z" }),
      d("y", { bornAt: "2026-04-01T00:00:00.000Z" }),
    ];
    assert.equal(pickCurrentDesire(desires)?.slug, "y");
  });

  test("time changes the winner: spark cools faster than enduring", () => {
    const atBirth = Date.parse("2026-01-01T00:00:00.000Z");
    const desires = [
      d("spark", {
        actionable: true,
        intensity: 0.9,
        horizon: "spark",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      d("enduring", {
        actionable: true,
        intensity: 0.6,
        horizon: "enduring",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    assert.equal(pickCurrentDesire(desires, {}, atBirth)?.slug, "spark");
    assert.equal(
      pickCurrentDesire(desires, {}, Date.parse("2026-01-08T00:00:00.000Z"))?.slug,
      "enduring",
    );
  });
});

describe("desire time dynamics", () => {
  test("effective intensity follows the configured half-life", () => {
    const desire = d("spark", {
      intensity: 0.8,
      horizon: "spark",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const afterThreeDays = effectiveDesireIntensity(
      desire,
      Date.parse("2026-01-04T00:00:00.000Z"),
    );
    assert.ok(Math.abs(afterThreeDays - 0.4) < 1e-9);
  });

  test("pursuit reinforces effective intensity without rewriting the desire", () => {
    const desire = d("old", {
      intensity: 0.7,
      horizon: "season",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const now = Date.parse("2026-04-01T00:00:00.000Z");
    const stale = effectiveDesireIntensity(desire, now);
    const reinforced = effectiveDesireIntensity(
      desire,
      now,
      "2026-04-01T00:00:00.000Z",
    );
    assert.ok(reinforced > stale);
    assert.equal(reinforced, 0.7);
  });

  test("review cadence depends on horizon and ignores closed desires", () => {
    const now = Date.parse("2026-01-05T00:00:00.000Z");
    assert.equal(
      isDesireReviewDue(
        d("spark", {
          horizon: "spark",
          updatedAt: "2026-01-03T00:00:00.000Z",
        }),
        now,
      ),
      true,
    );
    assert.equal(
      isDesireReviewDue(
        d("season", {
          horizon: "season",
          updatedAt: "2026-01-03T00:00:00.000Z",
        }),
        now,
      ),
      false,
    );
    assert.equal(
      isDesireReviewDue(
        d("closed", {
          closed: true,
          updatedAt: "2020-01-01T00:00:00.000Z",
        }),
        now,
      ),
      false,
    );
  });
});
