import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AccountRecord } from "../web/accounts.js";
import type { AdmissionDependencies } from "./admission.js";
import type { TurnLease } from "../cloud/turn-lease.js";
import type { UsageRecord } from "./meter.js";

const { admitInference } = await import("./admission.js");

const ACCT: AccountRecord = {
  uid: "u-1",
  kind: "email",
  email: "u@example.com",
  createdAt: 1,
  lastLoginAt: 1,
  verified: true,
  sessionVersion: 0,
};
const LEASE: TurnLease = "off";
const USAGE_RECORD: UsageRecord = {
  at: "2026-07-26T00:00:00.000Z",
  source: "test",
  model: "glm-4.6",
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  microUSD: 3,
  pricesVersion: 1,
};

function deps(overrides: Partial<AdmissionDependencies> = {}): {
  value: AdmissionDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    value: {
      preflight: () => {
        calls.push("limits");
        return { ok: true };
      },
      acquire: async () => {
        calls.push("acquire");
        return LEASE;
      },
      precheck: async () => {
        calls.push("quota");
        return { ok: true, budgetMicroUSD: 123 };
      },
      startRenewal: () => {
        calls.push("renew");
        return () => calls.push("stop");
      },
      releaseLease: async () => {
        calls.push("release");
      },
      settle: async () => {
        calls.push("settle");
        return USAGE_RECORD;
      },
      ...overrides,
    },
  };
}

describe("admitInference", () => {
  test("a limit rejection performs no quota or lease work", async () => {
    const d = deps({
      preflight: () => ({
        ok: false,
        status: 402,
        body: { error: "service_paused" },
      }),
    });
    const result = await admitInference(ACCT, "glm-4.6", d.value);
    assert.deepEqual(result, {
      ok: false,
      status: 402,
      body: { error: "service_paused" },
    });
    assert.deepEqual(d.calls, []);
  });

  test("a busy tenant gets the shared turn_in_progress response", async () => {
    const d = deps({
      acquire: async () => {
        d.calls.push("acquire");
        return null;
      },
    });
    const result = await admitInference(ACCT, "glm-4.6", d.value);
    assert.deepEqual(result, {
      ok: false,
      status: 429,
      body: { error: "turn_in_progress", retryAfterSec: 15 },
    });
    assert.deepEqual(d.calls, ["limits", "acquire"]);
  });

  test("quota rejection releases the acquired lease", async () => {
    const d = deps({
      precheck: async () => {
        d.calls.push("quota");
        return { ok: false, error: "premium_requires_balance", tier: "free" };
      },
    });
    const result = await admitInference(ACCT, "claude-sonnet", d.value);
    assert.deepEqual(result, {
      ok: false,
      status: 402,
      body: { error: "premium_requires_balance", tier: "free" },
    });
    assert.deepEqual(d.calls, ["limits", "acquire", "quota", "release"]);
  });

  test("a permit owns renewal and releases exactly once", async () => {
    const d = deps();
    const result = await admitInference(ACCT, "glm-4.6", d.value);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.permit.budgetMicroUSD, 123);
    await result.permit.release();
    await result.permit.release();
    assert.deepEqual(d.calls, ["limits", "acquire", "quota", "renew", "stop", "release"]);
  });

  test("settlement is owned by the permit and is idempotent", async () => {
    const d = deps();
    const result = await admitInference(ACCT, "glm-4.6", d.value);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const first = await result.permit.settle("reflect", usage);
    const second = await result.permit.settle("ignored", { ...usage, outputTokens: 999 });
    assert.equal(first, USAGE_RECORD);
    assert.equal(second, USAGE_RECORD);
    assert.equal(d.calls.filter((call) => call === "settle").length, 1);
    await result.permit.release();
  });

  test("a quota storage failure cannot leak the lease", async () => {
    const d = deps({
      precheck: async () => {
        d.calls.push("quota");
        throw new Error("balance unavailable");
      },
    });
    await assert.rejects(() => admitInference(ACCT, "glm-4.6", d.value), /balance unavailable/);
    assert.deepEqual(d.calls, ["limits", "acquire", "quota", "release"]);
  });
});
