import assert from "node:assert/strict";
import { test } from "node:test";
import { ReflectionInterruptedError, type ReflectionResult } from "../reflect.js";
import type { ProviderUsage } from "../providers/types.js";
import { reflectWithUsage } from "./reflect-request.js";

const used = { inputTokens: 12, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 0 };
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const done: ReflectionResult = { summary: "Finished.", raw: "", applied: [], skipped: [] };

test("reflect settles prior completed model work exactly once on cancellation or invalidation", async () => {
  for (const code of [
    "reflection_cancelled",
    "reflection_invalidated",
    "reflection_failed",
  ] as const) {
    const charges: ProviderUsage[] = [];
    const error = new ReflectionInterruptedError(code, used, new Error("private-path"));
    await assert.rejects(
      reflectWithUsage(
        async () => {
          throw error;
        },
        async (usage) => charges.push(usage),
      ),
      (e) => e === error,
    );
    assert.deepEqual(charges, [used]);
    assert.equal(error.message, code);
  }
});

test("normal completions settle once, busy or duplicate requests use no model tokens", async () => {
  const charges: ProviderUsage[] = [];
  const settle = async (usage: ProviderUsage) => {
    charges.push(usage);
  };
  await reflectWithUsage(async () => ({ ...done, usage: used }), settle);
  await reflectWithUsage(async () => ({ ...done, duplicate: true }), settle);
  await assert.rejects(
    reflectWithUsage(async () => {
      throw new ReflectionInterruptedError("reflection_busy", zero);
    }, settle),
    ReflectionInterruptedError,
  );
  assert.deepEqual(charges, [used]);
});

test("a failed settlement is propagated without a second debit attempt", async () => {
  let calls = 0;
  const error = new Error("billing unavailable");
  await assert.rejects(
    reflectWithUsage(
      async () => ({ ...done, usage: used }),
      async () => {
        calls++;
        throw error;
      },
    ),
    (e) => e === error,
  );
  assert.equal(calls, 1);
});
