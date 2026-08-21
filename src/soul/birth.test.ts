import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-birth-"));
process.env.LISA_HOME = TMP;
process.env.LISA_SOUL_GIT = "0"; // keep tests fast; git no-op path is itself S3 behavior

const { birth, BirthInferenceError, seedForPrompt } = await import("./birth.js");
const { isBorn } = await import("./store.js");
const { soulSeedFile, soulNameFile } = await import("./paths.js");
import type { BirthOutput } from "./birth.js";

const GOOD: BirthOutput = {
  name: "Lisa",
  identity: "I am steady and curious. ".repeat(3),
  purpose: "I make my human sharper. ".repeat(2),
  constitution: "1. Be honest\n2. Finish things\n3. Stay curious\n4. Keep confidences\n5. Show up",
  first_value: { slug: "honest-momentum", title: "Honest Momentum", body: "Progress that doesn't lie about itself." },
  first_desire: { slug: "learn-my-human", what: "Get a feel for how this person works", why: "Everything starts there", actionable: false },
};

beforeEach(() => {
  fs.rmSync(path.join(TMP, "soul"), { recursive: true, force: true });
});

describe("birth transactionality (S3)", () => {
  test("a dream that fails twice leaves NO seed — not half-born, re-runnable", async () => {
    let calls = 0;
    await assert.rejects(
      birth({
        dreamFn: async () => {
          calls++;
          throw new Error("provider exploded");
        },
      }),
      /provider exploded/,
    );
    assert.equal(calls, 2); // one retry happened
    assert.equal(fs.existsSync(soulSeedFile()), false);
    assert.equal(await isBorn(), false);
    // and a re-run is NOT refused as "already born"
    await birth({ dreamFn: async () => GOOD });
    assert.equal(await isBorn(), true);
  });

  test("first dream fails, retry succeeds — born in one call", async () => {
    let calls = 0;
    const steps: string[] = [];
    await birth({
      onStep: (l) => {
        steps.push(l.step);
      },
      dreamFn: async () => {
        calls++;
        if (calls === 1) throw new Error("flake");
        return GOOD;
      },
    });
    assert.equal(calls, 2);
    assert.equal(await isBorn(), true);
    assert.equal(fs.readFileSync(soulNameFile(), "utf8").trim(), "Lisa");
    assert.ok(steps.includes("done"));
  });

  test("second birth is refused once born", async () => {
    await birth({ dreamFn: async () => GOOD });
    await assert.rejects(birth({ dreamFn: async () => GOOD }), /already born/);
  });

  test("returns all provider token classes for account settlement", async () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
    };
    const result = await birth({
      dreamFn: async () => ({ output: GOOD, usage }),
    });
    assert.deepEqual(result.usage, usage);
  });

  test("a billable malformed first dream is included when the retry succeeds", async () => {
    let calls = 0;
    const result = await birth({
      dreamFn: async () => {
        calls++;
        if (calls === 1) {
          throw new BirthInferenceError("malformed", {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          });
        }
        return {
          output: GOOD,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
          },
        };
      },
    });
    assert.deepEqual(result.usage, {
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
  });

  test("known usage survives a failed retry so the caller can still settle", async () => {
    let calls = 0;
    await assert.rejects(
      birth({
        dreamFn: async () => {
          calls++;
          throw new BirthInferenceError(`malformed-${calls}`, {
            inputTokens: calls,
            outputTokens: calls * 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof BirthInferenceError);
        assert.deepEqual(err.usage, {
          inputTokens: 3,
          outputTokens: 6,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        return true;
      },
    );
  });
});

describe("birth prompt does not carry the device fingerprint", () => {
  const seed = {
    bornAt: "2026-08-21T00:00:00.000Z",
    bornOn: "b0b0b0b0deadbeefcafef00d1234567890abcdef1234567890abcdef12345678",
    randomness: "a".repeat(64),
    bigFive: {
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
    },
  };

  test("seedForPrompt strips bornOn and keeps what the dream actually needs", () => {
    const forPrompt = seedForPrompt(seed);
    assert.equal("bornOn" in forPrompt, false, "bornOn must not reach the provider");
    assert.equal(forPrompt.bornAt, seed.bornAt);
    assert.equal(forPrompt.randomness, seed.randomness);
    assert.deepEqual(forPrompt.bigFive, seed.bigFive);
  });

  test("the serialized prompt payload contains no trace of the hash", () => {
    // This is the actual wire shape: dreamSoul() JSON-stringifies the result of
    // seedForPrompt() into the user message sent to the model provider.
    const payload = JSON.stringify(seedForPrompt(seed), null, 2);
    assert.equal(payload.includes(seed.bornOn), false);
    assert.equal(payload.includes("bornOn"), false);
  });

  test("seedForPrompt does not mutate the seed that gets written to disk", () => {
    const copy = { ...seed };
    seedForPrompt(copy);
    assert.equal(copy.bornOn, seed.bornOn);
  });
});
