import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AccountRecord } from "../web/accounts.js";
import type { TurnLease } from "../cloud/turn-lease.js";
import type { MediaUsageRecord } from "./media-meter.js";
import {
  admitMedia,
  type MediaAdmissionDependencies,
} from "./media-admission.js";

const ACCT: AccountRecord = {
  uid: "u-media",
  kind: "apple",
  createdAt: "2026-07-26T00:00:00.000Z",
  verified: true,
  sessionVersion: 0,
};
const LEASE: TurnLease = "off";
const RECORD: MediaUsageRecord = {
  at: "2026-07-26T00:00:00.000Z",
  source: "voice_transcription",
  provider: "elevenlabs",
  model: "scribe_v2",
  durationMs: 1000,
  microUSD: 86,
  pricesVersion: 1,
};

function dependencies(
  overrides: Partial<MediaAdmissionDependencies> = {},
): { value: MediaAdmissionDependencies; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    value: {
      limits: () => {
        calls.push("limits");
        return { ok: true };
      },
      precheck: async () => {
        calls.push("precheck");
        return { ok: true, budgetMicroUSD: 1000 };
      },
      acquire: async () => {
        calls.push("acquire");
        return LEASE;
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
        return RECORD;
      },
      ...overrides,
    },
  };
}

describe("admitMedia", () => {
  test("a limit rejection performs no quota or lease work", async () => {
    const deps = dependencies({
      limits: () => ({ ok: false, status: 402, body: { error: "service_paused" } }),
    });
    const result = await admitMedia(ACCT, deps.value);
    assert.equal(result.ok, false);
    assert.deepEqual(deps.calls, []);
  });

  test("settlement and release are both idempotent", async () => {
    const deps = dependencies();
    const result = await admitMedia(ACCT, deps.value);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const usage = {
      provider: "elevenlabs" as const,
      model: "scribe_v2",
      durationMs: 1000,
    };
    assert.equal(await result.permit.settle("voice_transcription", usage), RECORD);
    assert.equal(await result.permit.settle("ignored", { ...usage, durationMs: 9999 }), RECORD);
    await result.permit.release();
    await result.permit.release();
    assert.equal(deps.calls.filter((call) => call === "settle").length, 1);
    assert.equal(deps.calls.filter((call) => call === "release").length, 1);
  });

  test("quota rejection releases the acquired lease", async () => {
    const deps = dependencies({
      precheck: async () => ({
        ok: false,
        error: "premium_requires_balance",
        tier: "free",
      }),
    });
    const result = await admitMedia(ACCT, deps.value);
    assert.equal(result.ok, false);
    assert.deepEqual(deps.calls, ["limits", "acquire", "release"]);
  });
});
