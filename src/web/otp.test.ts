import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-otp-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "otp.json");

const {
  requestEmailOtp,
  verifyEmailOtp,
  peekOtpRecord,
  OTP_TTL_MS,
  OTP_COOLDOWN_MS,
  OTP_DAILY_MAX_SENDS,
  OTP_MAX_ATTEMPTS,
  OTP_CODE_LENGTH,
} = await import("./otp.js");

/** Mint a code, asserting the request succeeded. */
async function mint(email: string, at: number): Promise<string> {
  const r = await requestEmailOtp(email, at);
  assert.equal(r.ok, true, "expected the request to be allowed");
  return (r as { ok: true; code: string }).code;
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe("otp — minting", () => {
  test("returns a fixed-length numeric code and stores only its hash", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const code = await mint("Person@Example.com ", t0);
    assert.match(code, new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`));

    const raw = fs.readFileSync(FILE, "utf8");
    assert.ok(!raw.includes(code), "the raw code must never touch the store");
    const rec = await peekOtpRecord("person@example.com");
    assert.ok(rec?.codeHash, "a challenge should be outstanding");
    assert.equal(rec?.expiresAt, t0 + OTP_TTL_MS);
  });

  test("normalizes the address, so casing/whitespace hit one record", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const code = await mint("  USER@Example.com", t0);
    assert.deepEqual(await verifyEmailOtp("user@example.com", code, t0 + 1000), { ok: true });
  });

  test("a second request replaces the first code", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const first = await mint("a@b.com", t0);
    const second = await mint("a@b.com", t0 + OTP_COOLDOWN_MS);
    const at = t0 + OTP_COOLDOWN_MS + 1000;
    assert.deepEqual(await verifyEmailOtp("a@b.com", first, at), { ok: false, reason: "bad_code" });
    assert.deepEqual(await verifyEmailOtp("a@b.com", second, at), { ok: true });
  });
});

describe("otp — send budget", () => {
  test("a second send inside the cooldown is refused with a retry hint", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    await mint("a@b.com", t0);
    const again = await requestEmailOtp("a@b.com", t0 + 20_000);
    assert.equal(again.ok, false);
    assert.equal((again as { reason: string }).reason, "cooldown");
    assert.equal((again as { retryAfterSec: number }).retryAfterSec, 40);
  });

  test("the daily cap holds, and the refusal does not burn the live code", async () => {
    const t0 = Date.UTC(2026, 6, 23, 0, 0, 0);
    let at = t0;
    for (let i = 0; i < OTP_DAILY_MAX_SENDS; i++) {
      await mint("a@b.com", at);
      at += OTP_COOLDOWN_MS;
    }
    const capped = await requestEmailOtp("a@b.com", at);
    assert.equal(capped.ok, false);
    assert.equal((capped as { reason: string }).reason, "daily_cap");
    // Still holding a usable challenge from the last successful send.
    assert.ok((await peekOtpRecord("a@b.com"))?.codeHash);
  });

  test("the budget resets on the next UTC day", async () => {
    const t0 = Date.UTC(2026, 6, 23, 0, 0, 0);
    let at = t0;
    for (let i = 0; i < OTP_DAILY_MAX_SENDS; i++) {
      await mint("a@b.com", at);
      at += OTP_COOLDOWN_MS;
    }
    assert.equal((await requestEmailOtp("a@b.com", at)).ok, false);
    const nextDay = Date.UTC(2026, 6, 24, 0, 0, 0);
    assert.equal((await requestEmailOtp("a@b.com", nextDay)).ok, true);
  });

  test("spending a code does NOT refund the daily budget", async () => {
    const t0 = Date.UTC(2026, 6, 23, 0, 0, 0);
    let at = t0;
    for (let i = 0; i < OTP_DAILY_MAX_SENDS - 1; i++) {
      await mint("a@b.com", at);
      at += OTP_COOLDOWN_MS;
    }
    const last = await mint("a@b.com", at);
    at += 1000;
    assert.deepEqual(await verifyEmailOtp("a@b.com", last, at), { ok: true });
    // A spent code must not hand back a fresh send allowance.
    const after = await requestEmailOtp("a@b.com", at + OTP_COOLDOWN_MS);
    assert.equal(after.ok, false);
    assert.equal((after as { reason: string }).reason, "daily_cap");
  });
});

describe("otp — spending a code", () => {
  test("a code works once", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const code = await mint("a@b.com", t0);
    assert.deepEqual(await verifyEmailOtp("a@b.com", code, t0 + 1000), { ok: true });
    assert.deepEqual(await verifyEmailOtp("a@b.com", code, t0 + 2000), { ok: false, reason: "no_pending" });
  });

  test("expiry is enforced", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const code = await mint("a@b.com", t0);
    assert.deepEqual(await verifyEmailOtp("a@b.com", code, t0 + OTP_TTL_MS + 1), { ok: false, reason: "expired" });
  });

  test("the code burns after the attempt limit", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const code = await mint("a@b.com", t0);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) {
      assert.deepEqual(await verifyEmailOtp("a@b.com", wrong, t0 + 1000), { ok: false, reason: "bad_code" });
    }
    assert.deepEqual(await verifyEmailOtp("a@b.com", wrong, t0 + 1000), {
      ok: false,
      reason: "too_many_attempts",
    });
    // Burned: even the right code is gone now.
    assert.deepEqual(await verifyEmailOtp("a@b.com", code, t0 + 1000), { ok: false, reason: "no_pending" });
  });

  test("a code cannot be spent on a different address", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    const code = await mint("a@b.com", t0);
    await mint("c@d.com", t0);
    assert.deepEqual(await verifyEmailOtp("c@d.com", code, t0 + 1000), { ok: false, reason: "bad_code" });
  });

  test("an address with no outstanding code reports no_pending", async () => {
    assert.deepEqual(await verifyEmailOtp("nobody@example.com", "123456", Date.now()), {
      ok: false,
      reason: "no_pending",
    });
  });
});

describe("otp — store hygiene", () => {
  test("the file is private (0600)", async () => {
    await mint("a@b.com", Date.UTC(2026, 6, 23, 12, 0, 0));
    assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
  });

  test("dead records are pruned once their day and challenge are past", async () => {
    const t0 = Date.UTC(2026, 6, 23, 12, 0, 0);
    await mint("stale@b.com", t0);
    // Two days on: challenge expired and the send budget belongs to an old day.
    await mint("fresh@b.com", Date.UTC(2026, 6, 25, 12, 0, 0));
    const list = JSON.parse(fs.readFileSync(FILE, "utf8")) as { email: string }[];
    assert.deepEqual(
      list.map((r) => r.email),
      ["fresh@b.com"],
    );
  });
});
