import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type http from "node:http";

const { readCappedText, BodyTooLargeError, CTRL_BODY_LIMIT } = await import("./http-body.js");

/** A fake IncomingMessage: just the readable-stream surface the reader uses. */
function fakeReq(chunks: (string | Buffer)[]): http.IncomingMessage {
  return Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")))) as
    unknown as http.IncomingMessage;
}

describe("readCappedText (#260/#264/#266)", () => {
  test("reads a body under the cap, joining chunks and decoding utf8", async () => {
    // split a multi-byte char across chunks — a naive per-chunk toString mangles it
    const euro = Buffer.from("€", "utf8");
    const body = await readCappedText(
      fakeReq(["hello ", euro.subarray(0, 1), euro.subarray(1), " world"]),
      CTRL_BODY_LIMIT,
    );
    assert.equal(body, "hello € world");
  });

  test("rejects past the cap with BodyTooLargeError carrying the limit", async () => {
    const req = fakeReq(["x".repeat(64), "y".repeat(64)]);
    await assert.rejects(
      () => readCappedText(req, 100),
      (e: unknown) => e instanceof BodyTooLargeError && e.limitBytes === 100,
    );
  });

  test("a body exactly at the cap is accepted (boundary is inclusive)", async () => {
    assert.equal((await readCappedText(fakeReq(["x".repeat(100)]), 100)).length, 100);
  });

  test("an empty body reads as the empty string", async () => {
    assert.equal(await readCappedText(fakeReq([]), CTRL_BODY_LIMIT), "");
  });

  test("a stream error propagates instead of hanging", async () => {
    const req = new Readable({
      read() {
        this.destroy(new Error("socket reset"));
      },
    }) as unknown as http.IncomingMessage;
    await assert.rejects(() => readCappedText(req, CTRL_BODY_LIMIT), /socket reset/);
  });
});
