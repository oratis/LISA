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
const { moodBus, moodAgeLabel, withMoodOrigin } = await import("./mood-bus.js");

const HOME_A = homeForUid("apple-001.aaa");
const HOME_B = homeForUid("em-bbbbbbbbbbbbbbbbbb");
const UID_C = "em-cccccccccccccccccc";
const UID_D = "em-dddddddddddddddddd";
const HOME_C = homeForUid(UID_C);
const HOME_D = homeForUid(UID_D);

function moodFile(home: string): string {
  return path.join(home, "current-mood.json");
}

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

describe("moodBus — the read side (currentState / origin / persistence)", () => {
  test("currentState() reports never-set as the default face", () => {
    fs.mkdirSync(HOME_C, { recursive: true });
    const s = homeScope.run(HOME_C, () => moodBus.currentState());
    assert.equal(s.slug, "neutral");
    assert.equal(s.at, 0); // 0 is what the prompt renders as "nobody has set it yet"
  });

  test("a mood records WHEN and WHAT KIND of turn set it", () => {
    fs.mkdirSync(HOME_D, { recursive: true });
    const before = Date.now();
    withMoodOrigin("an idle turn", () => homeScope.run(HOME_D, () => moodBus.set("sleepy")));
    const s = homeScope.run(HOME_D, () => moodBus.currentState());
    assert.equal(s.slug, "sleepy");
    assert.equal(s.by, "an idle turn");
    assert.ok(s.at >= before && s.at <= Date.now());
  });

  test("outside withMoodOrigin a change is attributed to a chat turn", () => {
    homeScope.run(HOME_D, () => moodBus.set("cheering"));
    assert.equal(homeScope.run(HOME_D, () => moodBus.currentState()).by, "a chat turn");
  });

  test("the slug is mirrored to <home>/current-mood.json", async () => {
    // The mirror is written fire-and-forget (see persist()), so wait for the
    // content rather than assuming the write landed before this line — and for
    // content, not mere existence: an in-flight write is briefly an empty file
    // (which is exactly why load() tolerates a torn read).
    let raw: { slug?: string; at?: number; by?: string } = {};
    for (let i = 0; i < 50 && !raw.slug; i++) {
      try {
        raw = JSON.parse(fs.readFileSync(moodFile(HOME_D), "utf8"));
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    assert.equal(raw.slug, "cheering");
    assert.equal(raw.by, "a chat turn");
    assert.equal(typeof raw.at, "number");
  });

  test("a restarted process hydrates the portrait from disk instead of snapping to neutral", () => {
    // A scope this process has never read or written — the only way it can
    // report "working-coding" is the file a previous run left behind. (Reading
    // a scope caches the miss, which is why this can't reuse HOME_C.)
    const home = homeForUid("em-ffffffffffffffffff");
    fs.mkdirSync(home, { recursive: true });
    const at = Date.now() - 90 * 60_000;
    fs.writeFileSync(
      moodFile(home),
      JSON.stringify({ slug: "working-coding", at, by: "a heartbeat turn" }),
    );
    const s = homeScope.run(home, () => moodBus.currentState());
    assert.equal(s.slug, "working-coding");
    assert.equal(s.by, "a heartbeat turn");
    assert.equal(s.at, at);
  });

  test("a corrupt mirror falls back to the default face rather than throwing", () => {
    const uid = "em-eeeeeeeeeeeeeeeeee";
    const home = homeForUid(uid);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(moodFile(home), "{not json");
    assert.equal(homeScope.run(home, () => moodBus.current()), "neutral");
  });

  test("forget(uid) deletes the mirror and never resurrects it from disk", () => {
    moodBus.forget(UID_D);
    assert.equal(fs.existsSync(moodFile(HOME_D)), false);
    assert.equal(homeScope.run(HOME_D, () => moodBus.current()), "neutral");
    // Even if the unlink had failed, the scope stays marked-hydrated.
    fs.writeFileSync(moodFile(HOME_D), JSON.stringify({ slug: "happy", at: 1, by: "x" }));
    assert.equal(homeScope.run(HOME_D, () => moodBus.current()), "neutral");
  });
});

describe("moodAgeLabel — coarse buckets (they feed the prompt fingerprint)", () => {
  const now = 1_700_000_000_000;
  const ago = (min: number): string => moodAgeLabel(now - min * 60_000, now);

  test("never-set is its own case", () => {
    assert.equal(moodAgeLabel(0, now), "never");
  });

  test("buckets widen with age", () => {
    assert.equal(ago(0), "moments ago");
    assert.equal(ago(4), "moments ago");
    assert.equal(ago(5), "within the last hour");
    assert.equal(ago(59), "within the last hour");
    assert.equal(ago(60), "a few hours ago");
    assert.equal(ago(300), "a few hours ago");
    assert.equal(ago(360), "earlier today");
    assert.equal(ago(1439), "earlier today");
    assert.equal(ago(1440), "over a day ago");
  });

  test("a clock skew into the future reads as fresh, not negative", () => {
    assert.equal(moodAgeLabel(now + 10_000, now), "moments ago");
  });
});
