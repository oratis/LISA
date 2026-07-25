import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { TenantRuntimeRegistry, tenantRuntimeOptions } = await import("./tenant-runtime.js");

describe("TenantRuntimeRegistry", () => {
  test("creates one runtime for overlapping requests to the same tenant", async () => {
    const registry = new TenantRuntimeRegistry<string>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    let creates = 0;
    const create = async () => {
      creates++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "runtime";
    };
    const [a, b] = await Promise.all([
      registry.acquire("u-1", create),
      registry.acquire("u-1", create),
    ]);
    assert.equal(creates, 1);
    assert.equal(a.value, b.value);
    assert.equal(registry.stats().pinned, 1);
    a.release();
    b.release();
    assert.equal(registry.stats().pinned, 0);
  });

  test("evicts idle entries by LRU while preserving pinned runtimes", async () => {
    let now = 0;
    const registry = new TenantRuntimeRegistry<string>({
      ttlMs: 10_000,
      maxEntries: 2,
      now: () => now,
    });
    const a = await registry.acquire("a", async () => "a");
    now = 1;
    const b = await registry.acquire("b", async () => "b");
    b.release();
    now = 2;
    const c = await registry.acquire("c", async () => "c");
    c.release();

    assert.equal(registry.peek("a"), "a");
    assert.equal(registry.peek("b"), undefined);
    assert.equal(registry.peek("c"), "c");
    assert.equal(registry.stats().entries, 2);
    a.release();
  });

  test("expires idle runtimes but not a runtime in active use", async () => {
    let now = 0;
    const registry = new TenantRuntimeRegistry<string>({
      ttlMs: 100,
      maxEntries: 10,
      now: () => now,
    });
    const active = await registry.acquire("active", async () => "active");
    const idle = await registry.acquire("idle", async () => "idle");
    idle.release();
    now = 101;
    registry.sweep();
    assert.equal(registry.peek("idle"), undefined);
    assert.equal(registry.peek("active"), "active");
    active.release();
  });

  test("release is idempotent and failed creation is retryable", async () => {
    const registry = new TenantRuntimeRegistry<string>({
      ttlMs: 1000,
      maxEntries: 10,
    });
    await assert.rejects(
      () => registry.acquire("u", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    const lease = await registry.acquire("u", async () => "ok");
    lease.release();
    lease.release();
    assert.equal(registry.stats().pinned, 0);
  });
});

describe("tenantRuntimeOptions", () => {
  test("uses bounded defaults and accepts positive overrides", () => {
    assert.deepEqual(tenantRuntimeOptions({}), {
      ttlMs: 30 * 60_000,
      maxEntries: 100,
    });
    assert.deepEqual(
      tenantRuntimeOptions({
        LISA_TENANT_RUNTIME_TTL_MIN: "5",
        LISA_TENANT_RUNTIME_MAX: "20",
      }),
      { ttlMs: 5 * 60_000, maxEntries: 20 },
    );
  });
});
