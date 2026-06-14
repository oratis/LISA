import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isGranted,
  grant,
  revoke,
  revokeAll,
  listGrants,
  loadConsent,
  isExpired,
  SENSE_SIGNALS,
} from "./store.js";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-consent-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("consent store — default-off gate", () => {
  test("fresh install → every sense signal denied", () => {
    for (const sig of SENSE_SIGNALS) assert.equal(isGranted(sig), false);
    assert.equal(isGranted("anything-unknown"), false);
  });

  test("grant flips the gate on, records grantedAt + options; others stay off", () => {
    grant("screen", { retentionDays: 7 }, 1000);
    assert.equal(isGranted("screen"), true);
    assert.equal(isGranted("voice"), false);
    const row = listGrants().find((r) => r.signal === "screen")!;
    assert.equal(row.granted, true);
    assert.equal(row.grantedAt, new Date(1000).toISOString());
    assert.deepEqual(row.options, { retentionDays: 7 });
  });

  test("revoke turns one off, leaves the rest", () => {
    grant("screen");
    grant("voice");
    revoke("screen");
    assert.equal(isGranted("screen"), false);
    assert.equal(isGranted("voice"), true);
  });

  test("revokeAll stops everything (one-tap)", () => {
    grant("screen");
    grant("voice");
    grant("clipboard");
    revokeAll();
    for (const sig of SENSE_SIGNALS) assert.equal(isGranted(sig), false);
    assert.equal(isGranted("clipboard"), false);
  });

  test("corrupt file fails closed (denied)", () => {
    fs.writeFileSync(path.join(home, "consent.json"), "{ not json");
    assert.equal(isGranted("screen"), false);
    assert.deepEqual(loadConsent(), { grants: {} });
  });

  test("listGrants always includes every canonical signal", () => {
    const sigs = listGrants().map((r) => r.signal);
    for (const s of SENSE_SIGNALS) assert.ok(sigs.includes(s), `missing ${s}`);
  });
});

describe("isExpired — retention", () => {
  const DAY = 24 * 60 * 60_000;
  test("within window → false; past window → true", () => {
    const now = 10 * DAY;
    assert.equal(isExpired(now - 1 * DAY, 7, now), false);
    assert.equal(isExpired(now - 8 * DAY, 7, now), true);
  });
  test("retentionDays ≤ 0 / non-finite → expire immediately (fail safe)", () => {
    const now = 10 * DAY;
    assert.equal(isExpired(now, 0, now), true);
    assert.equal(isExpired(now, -1, now), true);
    assert.equal(isExpired(now, NaN, now), true);
  });
});
