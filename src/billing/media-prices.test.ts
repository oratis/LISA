import test from "node:test";
import assert from "node:assert/strict";
import { mediaCostMicroUSD, mediaHourlyUSD } from "./media-prices.js";

test("duration prices use provider-native units plus the shared margin", () => {
  assert.equal(
    mediaCostMicroUSD({
      provider: "elevenlabs",
      model: "scribe_v2",
      durationMs: 3_600_000,
    }),
    308_000,
  );
  assert.equal(
    mediaCostMicroUSD({
      provider: "openai",
      model: "whisper-1",
      durationMs: 60_000,
    }),
    8_400,
  );
});

test("an unknown media model gets the conservative supported fallback", () => {
  assert.equal(mediaHourlyUSD("elevenlabs", "future-model"), 0.36);
  assert.equal(
    mediaCostMicroUSD({
      provider: "elevenlabs",
      model: "future-model",
      durationMs: 3_600_000,
    }),
    504_000,
  );
});

test("invalid durations can never poison the ledger", () => {
  assert.equal(
    mediaCostMicroUSD({
      provider: "openai",
      model: "whisper-1",
      durationMs: Number.NaN,
    }),
    0,
  );
});
