import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-sweep-"));
process.env.LISA_HOME = TMP;
process.env.LISA_SOUL_GIT = "0";

const { sweepToken, sweepUserAutonomy, SWEEP_INTERVALS_MS } = await import("./autonomy-sweep.js");
const { homeScope, homeForUid } = await import("../paths.js");
const { birth } = await import("../soul/birth.js");
import type { BirthOutput } from "../soul/birth.js";

const GOOD: BirthOutput = {
  name: "Lisa",
  identity: "Steady and curious.",
  purpose: "Make my human sharper.",
  constitution: "1. Be honest\n2. Finish things\n3. Stay curious\n4. Keep confidences\n5. Show up",
  first_value: { slug: "honest-momentum", title: "Honest Momentum", body: "Progress that doesn't lie." },
  first_desire: { slug: "learn-my-human", what: "Learn my human", why: "Start there", actionable: false },
};

const NOW = 1_800_000_000_000;

function seedAccounts(records: object[]): void {
  fs.writeFileSync(path.join(TMP, "accounts.json"), JSON.stringify(records));
}

function acct(uid: string, lastLoginAt: number): object {
  return { uid, kind: "email", email: `${uid}@x.co`, createdAt: 1, lastLoginAt, verified: true, sessionVersion: 0 };
}

beforeEach(() => {
  fs.rmSync(path.join(TMP, "users"), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, "accounts.json"), { force: true });
});

describe("autonomy sweep (S4)", () => {
  test("token config: default-OFF", () => {
    assert.equal(sweepToken({}), null);
    assert.equal(sweepToken({ LISA_SWEEP_TOKEN: " s3cret " }), "s3cret");
  });

  test("only recently-active accounts are scanned; unborn souls skip", async () => {
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    seedAccounts([acct("u-fresh", NOW - 1000), acct("u-stale", NOW - eightDays)]);
    const report = await sweepUserAutonomy({ now: NOW });
    assert.equal(report.scanned, 1); // the stale one never enters the sweep
    assert.equal(report.ran, 0);
    assert.deepEqual(report.outcomes, [{ uid: "u-fresh", action: "skipped", reason: "unborn" }]);
  });

  test("a born soul with a fresh stamp is not_due; a due one without sessions is no_sessions", async () => {
    seedAccounts([acct("u-born", NOW - 1000)]);
    await homeScope.run(homeForUid("u-born"), () => birth({ dreamFn: async () => GOOD }));
    // fresh stamp → not_due (free tier: 24h interval)
    const autonomyDir = path.join(TMP, "users", "u-born", "autonomy");
    fs.mkdirSync(autonomyDir, { recursive: true });
    fs.writeFileSync(path.join(autonomyDir, "last-cloud-sweep.json"), JSON.stringify({ at: NOW - 1000 }));
    let report = await sweepUserAutonomy({ now: NOW });
    assert.deepEqual(report.outcomes, [{ uid: "u-born", action: "skipped", reason: "not_due" }]);
    // stamp older than the free interval → due, but no sessions to reflect on
    fs.writeFileSync(
      path.join(autonomyDir, "last-cloud-sweep.json"),
      JSON.stringify({ at: NOW - SWEEP_INTERVALS_MS.free - 1 }),
    );
    report = await sweepUserAutonomy({ now: NOW });
    assert.deepEqual(report.outcomes, [{ uid: "u-born", action: "skipped", reason: "no_sessions" }]);
  });

  test("tier cadence: paid tiers sweep far more often than free", () => {
    assert.ok(SWEEP_INTERVALS_MS.tier2 < SWEEP_INTERVALS_MS.tier1);
    assert.ok(SWEEP_INTERVALS_MS.tier1 < SWEEP_INTERVALS_MS.free);
    assert.equal(SWEEP_INTERVALS_MS.free, SWEEP_INTERVALS_MS["free-unverified"]);
  });

  test("one user's failure never blocks the rest", async () => {
    seedAccounts([acct("u-a", NOW - 1000), acct("u-b", NOW - 1000)]);
    // u-a gets a CORRUPT soul dir (a file where the dir should be) to force an error path
    fs.mkdirSync(path.join(TMP, "users", "u-a"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "users", "u-a", "soul"), "not a directory");
    const report = await sweepUserAutonomy({ now: NOW });
    assert.equal(report.outcomes.length, 2);
    const b = report.outcomes.find((o) => o.uid === "u-b");
    assert.deepEqual(b, { uid: "u-b", action: "skipped", reason: "unborn" });
  });
});
