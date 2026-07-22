import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Give the path helpers a throwaway global home before anything imports them,
// matching src/web/tenancy.test.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-mood-"));
process.env.LISA_HOME = TMP;

const { homeScope, homeForUid } = await import("./paths.js");
const { moodBus } = await import("./mood-bus.js");

const HOME_A = homeForUid("apple-001.aaa");
const HOME_B = homeForUid("em-bbbbbbbbbbbbbbbbbb");

describe("moodBus — per-tenant mood state (B2)", () => {
  test("current() defaults to neutral outside any scope", () => {
    assert.equal(moodBus.current(), "neutral");
  });

  test("a mood set in scope A is NOT visible in scope B or globally", () => {
    homeScope.run(HOME_A, () => moodBus.set("happy"));
    homeScope.run(HOME_B, () => moodBus.set("gloomy"));

    // Each tenant reads back only its own mood…
    homeScope.run(HOME_A, () => assert.equal(moodBus.current(), "happy"));
    homeScope.run(HOME_B, () => assert.equal(moodBus.current(), "gloomy"));
    // …and neither leaked into the global (Mac / background) scope.
    assert.equal(moodBus.current(), "neutral");
  });

  test("the global scope is independent of any tenant", () => {
    moodBus.set("focused"); // no scope → global
    assert.equal(moodBus.current(), "focused");
    // Tenants set earlier are unchanged by a global set.
    homeScope.run(HOME_A, () => assert.equal(moodBus.current(), "happy"));
  });

  test("current() reads the CALLER's scope, so a fresh connection sees its own mood", () => {
    // Simulates the /events + /chat + island-ping connect frames, which call
    // moodBus.current() while already inside the subscriber's home scope.
    const seenByA = homeScope.run(HOME_A, () => moodBus.current());
    const seenByB = homeScope.run(HOME_B, () => moodBus.current());
    assert.equal(seenByA, "happy");
    assert.equal(seenByB, "gloomy");
    assert.notEqual(seenByA, seenByB);
  });

  test("forget(uid) drops a deleted account's mood back to neutral", () => {
    homeScope.run(HOME_A, () => assert.equal(moodBus.current(), "happy"));
    moodBus.forget("apple-001.aaa");
    homeScope.run(HOME_A, () => assert.equal(moodBus.current(), "neutral"));
    // Forgetting A never touches B or the global mood.
    homeScope.run(HOME_B, () => assert.equal(moodBus.current(), "gloomy"));
    assert.equal(moodBus.current(), "focused");
  });
});
