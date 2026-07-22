import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.LISA_FIRESTORE_PROJECT = "test-project";

const {
  toFsFields, fromFsFields, toFsValue, fromFsValue,
  getDoc, setDoc, casUpdate, acquireLease, releaseLease,
  FirestoreError, _resetFirestoreCachesForTests,
} = await import("./firestore.js");

/**
 * A tiny in-memory Firestore standing in for the REST API: token endpoint,
 * document GET/DELETE, and :commit with currentDocument preconditions.
 */
function fakeFirestore() {
  const docs = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  let version = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("metadata.google.internal")) {
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response("test-project", { status: 200 });
    }
    const docsBase = "/databases/(default)/documents";
    if (u.includes(":commit")) {
      const body = JSON.parse(String(init?.body)) as {
        writes: Array<{ update: { name: string; fields: Record<string, unknown> }; currentDocument?: { exists?: boolean; updateTime?: string } }>;
      };
      const w = body.writes[0]!;
      const path = w.update.name.split(`${docsBase}/`)[1]!;
      const existing = docs.get(path);
      const pre = w.currentDocument;
      if (pre) {
        if (pre.updateTime !== undefined) {
          if (!existing || existing.updateTime !== pre.updateTime) {
            return new Response(JSON.stringify({ error: "precondition" }), { status: 409 });
          }
        } else if (pre.exists === false && existing) {
          return new Response(JSON.stringify({ error: "exists" }), { status: 409 });
        }
      }
      docs.set(path, { fields: w.update.fields, updateTime: `v${++version}` });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    const path = u.split(`${docsBase}/`)[1];
    if (path && init?.method === "DELETE") {
      docs.delete(path);
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (path) {
      const doc = docs.get(path);
      if (!doc) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ fields: doc.fields, updateTime: doc.updateTime }), { status: 200 });
    }
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  return { fetchFn, docs };
}

beforeEach(() => {
  _resetFirestoreCachesForTests();
});

describe("value codec", () => {
  test("round-trips nested objects, arrays, ints, doubles, bools, nulls", () => {
    const obj = {
      s: "x", i: 42, d: 1.5, b: true, n: null,
      arr: [1, "two", { deep: false }],
      map: { inner: { k: "v" }, count: 7 },
    };
    assert.deepEqual(fromFsFields(toFsFields(obj)), obj);
    assert.deepEqual(fromFsValue(toFsValue([{ a: 1 }])), [{ a: 1 }]);
  });

  test("undefined fields are dropped, not encoded", () => {
    const fields = toFsFields({ keep: 1, drop: undefined });
    assert.deepEqual(Object.keys(fields), ["keep"]);
  });
});

describe("doc ops + CAS", () => {
  test("get missing → null; set → get round-trip", async () => {
    const { fetchFn } = fakeFirestore();
    assert.equal(await getDoc("col/doc", fetchFn), null);
    await setDoc("col/doc", { a: 1 }, undefined, fetchFn);
    const doc = await getDoc("col/doc", fetchFn);
    assert.deepEqual(doc?.data, { a: 1 });
  });

  test("exists:false create fails on a present doc", async () => {
    const { fetchFn } = fakeFirestore();
    await setDoc("col/doc", { a: 1 }, { exists: false }, fetchFn);
    await assert.rejects(
      setDoc("col/doc", { a: 2 }, { exists: false }, fetchFn),
      (e: unknown) => e instanceof FirestoreError && e.status === 409,
    );
  });

  test("casUpdate retries a lost race and lands the increment", async () => {
    const { fetchFn, docs } = fakeFirestore();
    await setDoc("col/counter", { n: 10 }, undefined, fetchFn);
    // Interfering fetch: the FIRST commit attempt is sabotaged by mutating the
    // doc between the read and the write (stale updateTime → 409 → retry).
    let sabotaged = false;
    const racing = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes(":commit") && !sabotaged) {
        sabotaged = true;
        docs.set("col/counter", { fields: toFsFields({ n: 100 }), updateTime: "raced" });
      }
      return fetchFn(url, init);
    }) as typeof fetch;
    const result = await casUpdate<number>(
      "col/counter",
      (cur) => {
        const n = (cur?.n as number) + 1;
        return { next: { n }, result: n };
      },
      racing,
    );
    // The retry read the raced value (100) and incremented THAT.
    assert.equal(result, 101);
    assert.equal((await getDoc("col/counter", fetchFn))?.data.n, 101);
  });
});

describe("turn lease", () => {
  test("acquire → busy for others → release frees it; expiry allows takeover", async () => {
    const { fetchFn } = fakeFirestore();
    const t0 = 1_700_000_000_000;
    const a = await acquireLease("turn-u1", "owner-a", 10_000, t0, fetchFn);
    assert.ok(a);
    // live lease blocks a different owner
    assert.equal(await acquireLease("turn-u1", "owner-b", 10_000, t0 + 1000, fetchFn), null);
    // same owner re-acquires (renewal semantics)
    assert.ok(await acquireLease("turn-u1", "owner-a", 10_000, t0 + 2000, fetchFn));
    // release → b can take it
    await releaseLease({ path: "lisa-leases/turn-u1", owner: "owner-a" }, fetchFn);
    assert.ok(await acquireLease("turn-u1", "owner-b", 10_000, t0 + 3000, fetchFn));
    // expiry → takeover without release
    assert.ok(await acquireLease("turn-u1", "owner-c", 10_000, t0 + 20_000, fetchFn));
  });
});
