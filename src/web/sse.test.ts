import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SSE_HEARTBEAT_MS,
  SSE_PING,
  attachSseHeartbeat,
  sseHeartbeatMs,
  startSseHeartbeat,
} from "./sse.js";

class FakeRes {
  writes: string[] = [];
  writableEnded = false;
  destroyed = false;
  throwOnWrite = false;
  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("write after end");
    this.writes.push(chunk);
    return true;
  }
}

class FakeReq {
  private closers: (() => void)[] = [];
  on(_event: "close", cb: () => void): this {
    this.closers.push(cb);
    return this;
  }
  close(): void {
    for (const c of this.closers) c();
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SSE heartbeat (T-11)", () => {
  test("the frame is an SSE comment, so no client dispatches an event for it", () => {
    assert.equal(SSE_PING, ": ping\n\n");
    assert.equal(SSE_HEARTBEAT_MS, 15_000);
  });

  test("pings on the interval until stopped", async () => {
    const res = new FakeRes();
    const stop = startSseHeartbeat(res, 10);
    await tick(45);
    stop();
    const seen = res.writes.length;
    assert.ok(seen >= 2, `expected repeated pings, saw ${seen}`);
    assert.ok(res.writes.every((w) => w === SSE_PING));
    await tick(30);
    assert.equal(res.writes.length, seen, "no pings after stop");
  });

  test("stops on its own once the response has ended", async () => {
    const res = new FakeRes();
    const stop = startSseHeartbeat(res, 10);
    await tick(25);
    const seen = res.writes.length;
    res.writableEnded = true;
    await tick(40);
    assert.equal(res.writes.length, seen, "no writes to a finished response");
    stop();
  });

  test("a write that throws stops the heartbeat instead of crashing the timer", async () => {
    const res = new FakeRes();
    res.throwOnWrite = true;
    const stop = startSseHeartbeat(res, 10);
    await tick(40);
    assert.equal(res.writes.length, 0);
    stop();
  });

  test("attachSseHeartbeat stops when the request closes", async () => {
    const req = new FakeReq();
    const res = new FakeRes();
    attachSseHeartbeat(req, res, 10);
    await tick(25);
    const seen = res.writes.length;
    assert.ok(seen >= 1);
    req.close();
    await tick(40);
    assert.equal(res.writes.length, seen);
  });

  test("LISA_SSE_HEARTBEAT_MS overrides the interval, floored so it can't busy-loop", () => {
    assert.equal(sseHeartbeatMs({}), SSE_HEARTBEAT_MS);
    assert.equal(sseHeartbeatMs({ LISA_SSE_HEARTBEAT_MS: "5000" }), 5000);
    assert.equal(sseHeartbeatMs({ LISA_SSE_HEARTBEAT_MS: "1" }), 10);
    assert.equal(sseHeartbeatMs({ LISA_SSE_HEARTBEAT_MS: "0" }), SSE_HEARTBEAT_MS);
    assert.equal(sseHeartbeatMs({ LISA_SSE_HEARTBEAT_MS: "soon" }), SSE_HEARTBEAT_MS);
  });

  test("stop() is idempotent", () => {
    const stop = startSseHeartbeat(new FakeRes(), 10_000);
    stop();
    stop();
  });
});
