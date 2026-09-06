import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-birth-"));
process.env.LISA_HOME = TMP;
process.env.LISA_SOUL_GIT = "0"; // keep tests fast; git no-op path is itself S3 behavior

const {
  birth,
  BirthInferenceError,
  DEFAULT_BIRTH_TIMEOUT_MS,
  birthTimeoutMs,
  classifyBirthError,
} = await import("./birth.js");
const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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

describe("birth error classification (T-8)", () => {
  /** Shapes the SDKs actually throw. */
  const apiError = (status: number, message: string) =>
    Object.assign(new Error(message), { name: "APIError", status });

  test("401 / 403 → auth, never retryable, and the key is never echoed", () => {
    for (const status of [401, 403]) {
      const info = classifyBirthError(apiError(status, '{"error":{"message":"invalid x-api-key sk-ant-SECRET"}}'));
      assert.equal(info.code, "auth");
      assert.equal(info.retryable, false);
      assert.match(info.message, /Settings/);
      assert.equal(info.message.includes("sk-ant-SECRET"), false);
      assert.equal(info.message.includes("{"), false, "no raw provider JSON");
    }
  });

  test("429 → rate_limit, retryable", () => {
    const info = classifyBirthError(apiError(429, "rate_limit_error"));
    assert.equal(info.code, "rate_limit");
    assert.equal(info.retryable, true);
  });

  test("AbortError and the deadline → timeout", () => {
    for (const err of [
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      Object.assign(new Error("x"), { name: "APIUserAbortError" }),
      Object.assign(new Error("x"), { code: "ABORT_ERR" }),
    ]) {
      assert.equal(classifyBirthError(err).code, "timeout");
    }
  });

  test("fetch / DNS / ECONN failures → network, including when wrapped in a cause chain", () => {
    assert.equal(classifyBirthError(new TypeError("fetch failed")).code, "network");
    assert.equal(
      classifyBirthError(Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } })).code,
      "network",
    );
    assert.equal(classifyBirthError(apiError(503, "upstream")).code, "network");
    // The wrapper our own code adds must not hide the classification.
    const wrapped = new BirthInferenceError("nested", ZERO, {
      cause: Object.assign(new Error("boom"), { status: 401 }),
    });
    assert.equal(classifyBirthError(wrapped).code, "auth");
  });

  test("anything else → unknown, retryable, with no provider text", () => {
    const info = classifyBirthError(new Error('{"weird":"provider blob"}'));
    assert.equal(info.code, "unknown");
    assert.equal(info.retryable, true);
    assert.equal(info.message.includes("provider blob"), false);
  });

  test("LISA_BIRTH_TIMEOUT_MS: unset → 90s, garbage and 0 → default", () => {
    assert.equal(birthTimeoutMs({}), DEFAULT_BIRTH_TIMEOUT_MS);
    assert.equal(DEFAULT_BIRTH_TIMEOUT_MS, 90_000);
    assert.equal(birthTimeoutMs({ LISA_BIRTH_TIMEOUT_MS: "5000" }), 5000);
    assert.equal(birthTimeoutMs({ LISA_BIRTH_TIMEOUT_MS: "0" }), DEFAULT_BIRTH_TIMEOUT_MS);
    assert.equal(birthTimeoutMs({ LISA_BIRTH_TIMEOUT_MS: "later" }), DEFAULT_BIRTH_TIMEOUT_MS);
  });
});

describe("birth retry policy (T-8)", () => {
  test("an auth failure is NOT retried — a rejected key cannot succeed twice", async () => {
    let calls = 0;
    await assert.rejects(
      birth({
        dreamFn: async () => {
          calls++;
          throw Object.assign(new Error("bad key"), { name: "APIError", status: 401 });
        },
      }),
      /bad key/,
    );
    assert.equal(calls, 1, "no retry");
    assert.equal(await isBorn(), false);
  });

  test("a rate limit IS retried, once, after a backoff", async () => {
    let calls = 0;
    const steps: string[] = [];
    await birth({
      rateLimitBackoffMs: 5,
      onStep: (l) => steps.push(l.detail),
      dreamFn: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("slow down"), { name: "APIError", status: 429 });
        return GOOD;
      },
    });
    assert.equal(calls, 2);
    assert.ok(steps.some((d) => /throttling/.test(d)), "the wait is announced");
    assert.equal(await isBorn(), true);
  });

  test("the retry notice never carries the provider's raw message", async () => {
    const steps: string[] = [];
    let calls = 0;
    await birth({
      onStep: (l) => steps.push(l.detail),
      dreamFn: async () => {
        calls++;
        if (calls === 1) throw new Error('{"error":{"message":"sk-ant-LEAKED"}}');
        return GOOD;
      },
    });
    assert.equal(steps.join("\n").includes("sk-ant-LEAKED"), false);
  });

  /** A provider that accepts the call and then never answers. */
  const neverAnswers = (signal: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      // An already-aborted signal never fires 'abort' again — check first, or
      // the fake provider hangs forever and takes the test run with it.
      if (signal.aborted) return fail();
      signal.addEventListener("abort", fail, { once: true });
    });

  test("the deadline aborts the provider call and surfaces as timeout", async () => {
    const err = await birth({
      timeoutMs: 30,
      dreamFn: (_seed, signal) => neverAnswers(signal),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err, "birth rejected");
    assert.equal(classifyBirthError(err).code, "timeout");
    assert.equal(await isBorn(), false);
  });

  test("a caller's abort signal stops the dream too", async () => {
    const ctl = new AbortController();
    const p = birth({
      signal: ctl.signal,
      dreamFn: (_seed, signal) => neverAnswers(signal),
    });
    ctl.abort();
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(classifyBirthError(err).code, "timeout");
    assert.equal(await isBorn(), false);
  });
});
