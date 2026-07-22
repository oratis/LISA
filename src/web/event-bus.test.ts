import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { TenantEventBus, sameTenant, type EventSink } from "./event-bus.js";

// Two uids in the same shape the account store mints (Apple / email accounts),
// mirroring src/web/tenancy.test.ts's HOME_A / HOME_B.
const UID_A = "apple-001.aaa";
const UID_B = "em-bbbbbbbbbbbbbbbbbb";

/** A fake SSE sink that records every frame written to it. */
class FakeSink implements EventSink {
  readonly frames: string[] = [];
  write(chunk: string): void {
    this.frames.push(chunk);
  }
  /** The `type` field of each event delivered, in order. */
  types(): string[] {
    return this.frames.map(
      (f) => JSON.parse(f.replace(/^data: /, "").trim()).type as string,
    );
  }
  /** Everything ever written, joined — for "did any byte leak?" assertions. */
  raw(): string {
    return this.frames.join("");
  }
}

describe("TenantEventBus — cross-tenant isolation (B2)", () => {
  test("a uid-A event is never delivered to a uid-B subscriber", () => {
    const bus = new TenantEventBus<FakeSink>();
    const a = new FakeSink();
    const b = new FakeSink();
    bus.add(a, UID_A);
    bus.add(b, UID_B);

    // The kind of event that carries private message TEXT.
    bus.broadcast(
      { type: "idle_message", text: "A's private musing", source: "advisor" },
      UID_A,
    );

    assert.deepEqual(a.types(), ["idle_message"]);
    assert.deepEqual(b.frames, []); // B received nothing at all
    assert.equal(b.raw().includes("private"), false); // not even a byte leaked
  });

  test("each tenant receives only its own stream of events", () => {
    const bus = new TenantEventBus<FakeSink>();
    const a = new FakeSink();
    const b = new FakeSink();
    bus.add(a, UID_A);
    bus.add(b, UID_B);

    bus.broadcast({ type: "mood", slug: "happy" }, UID_A);
    bus.broadcast({ type: "chat_start" }, UID_A);
    bus.broadcast({ type: "mood", slug: "sad" }, UID_B);
    bus.broadcast({ type: "chat_end" }, UID_A);

    assert.deepEqual(a.types(), ["mood", "chat_start", "chat_end"]);
    assert.deepEqual(b.types(), ["mood"]);
  });

  test("single-tenant (Mac): null origin + null subscriber → delivered", () => {
    const bus = new TenantEventBus<FakeSink>();
    const only = new FakeSink();
    bus.add(only, null);

    bus.broadcast({ type: "idle_message", text: "hello" }, null);
    bus.broadcast({ type: "mood", slug: "neutral" }, null);

    // Unchanged from the pre-B2 behavior: the one implicit user sees everything.
    assert.deepEqual(only.types(), ["idle_message", "mood"]);
  });

  test("a signed-in cloud tenant does NOT receive global/background (null-origin) events", () => {
    const bus = new TenantEventBus<FakeSink>();
    const signedIn = new FakeSink();
    const shared = new FakeSink(); // legacy shared-token demo caller (null uid)
    bus.add(signedIn, UID_A);
    bus.add(shared, null);

    // The global idle scheduler runs outside any per-uid scope → origin null.
    bus.broadcast({ type: "idle_message", text: "global soul musing" }, null);

    assert.deepEqual(signedIn.frames, []); // the global soul never leaks to a tenant
    assert.deepEqual(shared.types(), ["idle_message"]);
  });

  test("two subscribers for the SAME tenant (e.g. two tabs) both receive it", () => {
    const bus = new TenantEventBus<FakeSink>();
    const tab1 = new FakeSink();
    const tab2 = new FakeSink();
    const otherTenant = new FakeSink();
    bus.add(tab1, UID_A);
    bus.add(tab2, UID_A);
    bus.add(otherTenant, UID_B);

    bus.broadcast({ type: "mood", slug: "curious" }, UID_A);

    assert.deepEqual(tab1.types(), ["mood"]);
    assert.deepEqual(tab2.types(), ["mood"]);
    assert.deepEqual(otherTenant.frames, []);
  });

  test("unsubscribe stops delivery and frees the slot", () => {
    const bus = new TenantEventBus<FakeSink>();
    const a = new FakeSink();
    const off = bus.add(a, UID_A);
    assert.equal(bus.size, 1);

    bus.broadcast({ type: "mood", slug: "happy" }, UID_A);
    off();
    bus.broadcast({ type: "mood", slug: "sad" }, UID_A);

    assert.deepEqual(a.types(), ["mood"]); // only the pre-unsubscribe frame
    assert.equal(bus.size, 0);
  });

  test("the same sink can register twice and each slot is removed independently", () => {
    const bus = new TenantEventBus<FakeSink>();
    const sink = new FakeSink();
    const off1 = bus.add(sink, UID_A);
    bus.add(sink, UID_A);
    assert.equal(bus.size, 2);

    off1();
    assert.equal(bus.size, 1); // only the first registration went away

    bus.broadcast({ type: "mood", slug: "happy" }, UID_A);
    assert.deepEqual(sink.types(), ["mood"]); // delivered once, via the surviving slot
  });

  test("a dead sink (throwing write) doesn't block delivery to its tenant-mates", () => {
    const bus = new TenantEventBus();
    const dead: EventSink = {
      write() {
        throw new Error("EPIPE: connection gone");
      },
    };
    const live = new FakeSink();
    bus.add(dead, UID_A);
    bus.add(live, UID_A);

    assert.doesNotThrow(() =>
      bus.broadcast({ type: "mood", slug: "happy" }, UID_A),
    );
    assert.deepEqual(live.types(), ["mood"]);
  });
});

describe("sameTenant predicate", () => {
  test("exact uid match, including null === null", () => {
    assert.equal(sameTenant(null, null), true); // Mac / shared-token
    assert.equal(sameTenant(UID_A, UID_A), true);
    assert.equal(sameTenant(UID_A, UID_B), false); // the leak this closes
    assert.equal(sameTenant(null, UID_A), false); // tenant event ↛ shared sub
    assert.equal(sameTenant(UID_A, null), false); // global event ↛ tenant sub
  });
});
