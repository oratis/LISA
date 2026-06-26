import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRetryableStreamError, withStreamRetry } from "./stream-retry.js";

describe("isRetryableStreamError", () => {
  test("matches the empty-stream error (the reported failure)", () => {
    assert.equal(
      isRetryableStreamError(
        new Error("request ended without sending any chunks"),
      ),
      true,
    );
  });

  test("matches proxy-induced connection drops", () => {
    for (const msg of [
      "Premature close",
      "socket hang up",
      "read ECONNRESET",
      "terminated",
      "fetch failed",
    ]) {
      assert.equal(isRetryableStreamError(new Error(msg)), true, msg);
    }
  });

  test("matches SDK connection error classes by name", () => {
    const e = new Error("conn");
    e.name = "APIConnectionError";
    assert.equal(isRetryableStreamError(e), true);
  });

  test("never retries a user abort", () => {
    const e = new Error("Request was aborted.");
    e.name = "APIUserAbortError";
    assert.equal(isRetryableStreamError(e), false);
  });

  test("does not match ordinary API errors (e.g. 400/401)", () => {
    assert.equal(
      isRetryableStreamError(new Error("400 invalid_request_error")),
      false,
    );
  });

  test("matches undici socket failures by cause.code", () => {
    const e = new Error("terminated");
    (e as { cause?: unknown }).cause = { code: "ECONNRESET" };
    assert.equal(isRetryableStreamError(e), true);
  });

  test("'terminated' is matched precisely, not as a substring", () => {
    // A real API message that merely contains the word must NOT trigger a
    // spurious re-send — only undici's exact `TypeError: terminated` counts.
    assert.equal(
      isRetryableStreamError(new Error("request terminated by content policy")),
      false,
    );
  });
});

describe("withStreamRetry", () => {
  const fast = { baseDelayMs: 0 as const };

  test("retries a transient empty-stream failure, then succeeds", async () => {
    let attempts = 0;
    const result = await withStreamRetry(fast, async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("request ended without sending any chunks");
      }
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  test("does NOT retry once a delta has been emitted (no duplicate output)", async () => {
    let attempts = 0;
    await assert.rejects(
      withStreamRetry(fast, async (markEmitted) => {
        attempts++;
        markEmitted();
        throw new Error("request ended without sending any chunks");
      }),
      /any chunks/,
    );
    assert.equal(attempts, 1);
  });

  test("does NOT retry a non-retryable error", async () => {
    let attempts = 0;
    await assert.rejects(
      withStreamRetry(fast, async () => {
        attempts++;
        throw new Error("401 authentication_error");
      }),
      /authentication_error/,
    );
    assert.equal(attempts, 1);
  });

  test("gives up after maxRetries and surfaces the last error", async () => {
    let attempts = 0;
    await assert.rejects(
      withStreamRetry({ baseDelayMs: 0, maxRetries: 2 }, async () => {
        attempts++;
        throw new Error("terminated");
      }),
      /terminated/,
    );
    assert.equal(attempts, 3); // 1 initial + 2 retries
  });

  test("an already-aborted signal stops retrying immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    let attempts = 0;
    await assert.rejects(
      withStreamRetry({ baseDelayMs: 0, signal: ac.signal }, async () => {
        attempts++;
        throw new Error("request ended without sending any chunks");
      }),
      /any chunks/,
    );
    assert.equal(attempts, 1);
  });
});
