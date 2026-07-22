import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-limits-"));
process.env.LISA_HOME = TMP;

const {
  rpmOk, resetRpm, globalSpendAdd, globalSpendExceeded, preflightLimits, killSwitchOn, dailyCapMicroUSD,
  ipRateOk, resetIpRate,
} = await import("./limits.js");

const T0 = Date.parse("2026-07-22T08:00:00Z");

beforeEach(() => {
  resetRpm();
  resetIpRate();
  fs.rmSync(path.join(TMP, "billing-global.json"), { force: true });
  delete process.env.LISA_BILLING_KILL;
  delete process.env.LISA_RPM_LIMIT;
  delete process.env.LISA_DAILY_CAP_USD;
});

describe("per-uid rpm", () => {
  test("limit applies per uid and slides with the minute", () => {
    process.env.LISA_RPM_LIMIT = "3";
    assert.ok(rpmOk("u1", T0));
    assert.ok(rpmOk("u1", T0 + 1));
    assert.ok(rpmOk("u1", T0 + 2));
    assert.equal(rpmOk("u1", T0 + 3), false);
    // other uid unaffected
    assert.ok(rpmOk("u2", T0 + 3));
    // a minute later the bucket has slid
    assert.ok(rpmOk("u1", T0 + 61_000));
  });
});

describe("per-key sliding window (#260)", () => {
  test("caps a key, isolates other keys, slides with the window", () => {
    assert.ok(ipRateOk("auth:1.2.3.4", 2, 600_000, T0));
    assert.ok(ipRateOk("auth:1.2.3.4", 2, 600_000, T0 + 1));
    assert.equal(ipRateOk("auth:1.2.3.4", 2, 600_000, T0 + 2), false);
    // a different IP is unaffected
    assert.ok(ipRateOk("auth:5.6.7.8", 2, 600_000, T0 + 2));
    // past the window the bucket has slid
    assert.ok(ipRateOk("auth:1.2.3.4", 2, 600_000, T0 + 600_001));
  });

  test("saturation fails OPEN — one client can't lock every new IP out (#260)", () => {
    // The key space is attacker-controlled (spoofable XFF), so flooding it must
    // not become a lockout: filling the map is exactly the cheap attack.
    for (let i = 0; i < 10_000; i++) assert.ok(ipRateOk(`auth:flood-${i}`, 20, 600_000, T0));
    // A brand-new legitimate IP still gets through rather than being refused.
    assert.equal(ipRateOk("auth:legit", 20, 600_000, T0), true);
    // ...while a key already in the map is still capped normally.
    for (let i = 1; i < 20; i++) ipRateOk("auth:flood-0", 20, 600_000, T0);
    assert.equal(ipRateOk("auth:flood-0", 20, 600_000, T0), false);
  });
});

describe("global daily cap", () => {
  test("accumulates within a UTC day, resets across days, persists on disk", () => {
    process.env.LISA_DAILY_CAP_USD = "1"; // $1 cap for the test
    assert.equal(globalSpendExceeded(T0), false);
    globalSpendAdd(600_000, T0);
    assert.equal(globalSpendExceeded(T0), false);
    globalSpendAdd(500_000, T0);
    assert.equal(globalSpendExceeded(T0), true);
    // next UTC day → fresh counter
    assert.equal(globalSpendExceeded(T0 + 24 * 60 * 60 * 1000), false);
    assert.ok(fs.existsSync(path.join(TMP, "billing-global.json")));
  });

  test("default cap is $200", () => {
    assert.equal(dailyCapMicroUSD({}), 200_000_000);
  });

  test("an unreadable counter fails CLOSED, and doesn't get clobbered (#267)", () => {
    const file = path.join(TMP, "billing-global.json");
    // A directory in the counter's place reads as EISDIR — an I/O error, not
    // ENOENT. Previously that read as $0 spent and disabled the cap silently.
    fs.mkdirSync(file, { recursive: true });
    try {
      assert.equal(globalSpendExceeded(T0), true);
      const v = preflightLimits("u1", T0);
      assert.ok(!v.ok && v.status === 402 && v.body.error === "service_paused");
      // the write path must not replace the unreadable counter with a fresh 0
      globalSpendAdd(1_000, T0);
      assert.ok(fs.statSync(file).isDirectory());
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });

  test("a corrupt counter file also fails closed (#267)", () => {
    fs.writeFileSync(path.join(TMP, "billing-global.json"), "{not json");
    assert.equal(globalSpendExceeded(T0), true);
  });
});

describe("preflight verdicts", () => {
  test("kill switch → 402 service_paused for everyone", () => {
    process.env.LISA_BILLING_KILL = "1";
    assert.ok(killSwitchOn());
    const v = preflightLimits("u1", T0);
    assert.ok(!v.ok && v.status === 402 && v.body.error === "service_paused");
  });

  test("over-rpm → 429; normal → ok", () => {
    process.env.LISA_RPM_LIMIT = "1";
    assert.deepEqual(preflightLimits("u9", T0), { ok: true });
    const v = preflightLimits("u9", T0 + 1);
    assert.ok(!v.ok && v.status === 429 && v.body.error === "rate_limited");
  });
});
