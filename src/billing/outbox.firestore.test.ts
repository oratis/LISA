/**
 * The Cloud adapter for the usage outbox.
 *
 * Every other outbox test runs against the JSONL store, which is the LOCAL
 * edition's. FirestoreOutboxStore — the one that decides whether a hosted
 * tenant gets charged once, twice or never — had no test at all: 18 of the
 * module's 47 functions were unexecuted, all of them here. Money-moving code
 * whose only validation is production is the wrong trade, so this exercises it
 * against the in-memory REST fake the firestore client's own tests use.
 *
 * `FirestoreOutboxStore` calls getDoc/setDoc/casUpdate without a fetchFn, so
 * the fake is installed as globalThis.fetch for the duration and restored
 * after — which has the side benefit of running the REAL firestore client
 * (value codec, preconditions, CAS retries) rather than a mock of it.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AccountRecord } from "../web/accounts.js";

process.env.LISA_FIRESTORE_PROJECT = "test-project";

const { _resetFirestoreCachesForTests } = await import("../cloud/firestore.js");
const {
  FirestoreOutboxStore,
  defaultOutboxStore,
  _resetOutboxStoreForTests,
  newUsageEvent,
  JsonlOutboxStore,
} = await import("./outbox.js");

/** Requests the fake served, so "sticky" and "one CAS" can be asserted. */
let calls: string[] = [];

/**
 * A tiny in-memory Firestore: the metadata token endpoint, document GET, and
 * :commit with `currentDocument` preconditions. Mirrors the fake in
 * src/cloud/firestore.test.ts.
 */
function fakeFirestore() {
  const docs = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  let version = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("metadata.google.internal")) {
      if (u.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response("test-project", { status: 200 });
    }
    const docsBase = "/databases/(default)/documents";
    if (u.includes(":commit")) {
      const body = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update: { name: string; fields: Record<string, unknown> };
          currentDocument?: { exists?: boolean; updateTime?: string };
        }>;
      };
      const w = body.writes[0]!;
      const path = w.update.name.split(`${docsBase}/`)[1]!;
      calls.push(`commit ${path}`);
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
    if (path) {
      calls.push(`get ${path}`);
      const doc = docs.get(path);
      if (!doc) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ fields: doc.fields, updateTime: doc.updateTime }), {
        status: 200,
      });
    }
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  return { fetchFn, docs };
}

const ACCT = { uid: "u-firestore-1" } as AccountRecord;

function event(uid: string, id: string, costMicros = 1_234) {
  return newUsageEvent(
    {
      acct: { uid } as AccountRecord,
      kind: "chat",
      model: "claude-sonnet-4-6",
      costMicros,
      reservationId: `res-${id}`,
      eventId: id,
    },
    1_700_000_000_000,
  );
}

let realFetch: typeof fetch;
let docs: Map<string, { fields: Record<string, unknown>; updateTime: string }>;

beforeEach(() => {
  const fake = fakeFirestore();
  docs = fake.docs;
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchFn;
  _resetFirestoreCachesForTests();
  _resetOutboxStoreForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetOutboxStoreForTests();
});

describe("FirestoreOutboxStore", () => {
  test("append writes the event and indexes it under the tenant", async () => {
    const store = new FirestoreOutboxStore();
    const e = event(ACCT.uid, "evt-1");
    await store.append(e);

    const doc = docs.get(`lisa-outbox/${ACCT.uid}/events/evt-1`);
    assert.ok(doc, "the event document was not created");
    const index = docs.get(`lisa-outbox/${ACCT.uid}`);
    assert.ok(index, "the tenant index was not created");

    // Round-trips through the value codec with every field intact.
    const read = await store.get(ACCT.uid, "evt-1");
    assert.deepEqual(read, e);
    // lastError is stored as "" and must not come back as an empty string.
    assert.equal("lastError" in (read as object), false);
  });

  test("append is idempotent by id: a replay neither duplicates nor throws", async () => {
    const store = new FirestoreOutboxStore();
    const e = event(ACCT.uid, "evt-dup");
    await store.append(e);
    // A retry of the same settlement — the id is the idempotency key, and the
    // exists:false precondition is what makes the second write a no-op rather
    // than a second charge waiting to happen.
    await store.append(e);

    const open = await store.listOpen(ACCT.uid);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.id, "evt-dup");
  });

  test("index-first ordering: an event is never written without an index entry", async () => {
    const store = new FirestoreOutboxStore();
    await store.append(event(ACCT.uid, "evt-order"));
    const indexWrite = calls.indexOf(`commit lisa-outbox/${ACCT.uid}`);
    const eventWrite = calls.indexOf(`commit lisa-outbox/${ACCT.uid}/events/evt-order`);
    assert.ok(indexWrite >= 0 && eventWrite >= 0);
    assert.ok(
      indexWrite < eventWrite,
      "a dangling index id self-heals; an unindexed event is invisible forever",
    );
  });

  test("update to committed drops the id from the open index", async () => {
    const store = new FirestoreOutboxStore();
    const e = event(ACCT.uid, "evt-commit");
    await store.append(e);
    assert.equal((await store.listOpen(ACCT.uid)).length, 1);

    await store.update({ ...e, status: "committed" });

    assert.deepEqual(await store.listOpen(ACCT.uid), []);
    // The document itself is kept — it is the audit trail, not a queue slot.
    assert.equal((await store.get(ACCT.uid, "evt-commit"))?.status, "committed");
  });

  test("update to a non-terminal status leaves it open and records the error", async () => {
    const store = new FirestoreOutboxStore();
    const e = event(ACCT.uid, "evt-retry");
    await store.append(e);
    await store.update({ ...e, status: "failed", attempts: 2, lastError: "ledger unavailable" });

    const open = await store.listOpen(ACCT.uid);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.attempts, 2);
    assert.equal(open[0]!.lastError, "ledger unavailable");
  });

  test("listOpen prunes ids whose document is gone or already committed", async () => {
    const store = new FirestoreOutboxStore();
    await store.append(event(ACCT.uid, "evt-live"));
    await store.append(event(ACCT.uid, "evt-vanished"));
    // Simulate the dangling half of the index-first write: the id is indexed,
    // the document never landed.
    docs.delete(`lisa-outbox/${ACCT.uid}/events/evt-vanished`);

    const open = await store.listOpen(ACCT.uid);
    assert.deepEqual(
      open.map((e) => e.id),
      ["evt-live"],
    );
    // Pruned for good, not re-walked on every sweep: a second listOpen reads
    // the rewritten index and never touches the vanished id again.
    calls = [];
    await store.listOpen(ACCT.uid);
    assert.equal(
      calls.some((c) => c.includes("evt-vanished")),
      false,
      "the dangling id survived the prune",
    );
  });

  test("listOpen returns oldest first, so the reconciler drains in order", async () => {
    const store = new FirestoreOutboxStore();
    const older = { ...event(ACCT.uid, "evt-older"), createdAt: 1_000 };
    const newer = { ...event(ACCT.uid, "evt-newer"), createdAt: 9_000 };
    await store.append(newer);
    await store.append(older);
    assert.deepEqual(
      (await store.listOpen(ACCT.uid)).map((e) => e.id),
      ["evt-older", "evt-newer"],
    );
  });

  test("listTenants aggregates every shard", async () => {
    const store = new FirestoreOutboxStore();
    // Enough uids that the sha256 shard function spreads them over more than
    // one of the eight registry documents.
    const uids = Array.from({ length: 12 }, (_, i) => `u-shard-${i}`);
    for (const uid of uids) await store.append(event(uid, `evt-${uid}`));

    const seen = await store.listTenants();
    assert.deepEqual([...seen].sort(), [...uids].sort());
    const shardDocs = [...docs.keys()].filter((k) => k.startsWith("lisa-outbox-tenants/"));
    assert.ok(shardDocs.length > 1, "the registry never sharded — one hot document");
  });

  test("tenant registration is sticky: repeat appends do not rewrite the registry", async () => {
    const store = new FirestoreOutboxStore();
    await store.append(event(ACCT.uid, "evt-a"));
    const afterFirst = calls.filter((c) => c.startsWith("commit lisa-outbox-tenants/")).length;
    assert.equal(afterFirst, 1);

    await store.append(event(ACCT.uid, "evt-b"));
    await store.append(event(ACCT.uid, "evt-c"));
    const afterMore = calls.filter((c) => c.startsWith("commit lisa-outbox-tenants/")).length;
    assert.equal(afterMore, 1, "the shared registry document is written once per process per uid");
  });

  test("draining a tenant's last event lets the registry forget it", async () => {
    const store = new FirestoreOutboxStore();
    const e = event(ACCT.uid, "evt-last");
    await store.append(e);
    assert.deepEqual(await store.listTenants(), [ACCT.uid]);

    await store.update({ ...e, status: "committed" });
    // A clean drain produces no STALE id — update() already removed the
    // committed id from the index — so the registry used to keep this uid
    // forever and the 15-minute reconcile sweep grew with every account that
    // ever settled anything. An index that exists and is empty means drained.
    assert.deepEqual(await store.listOpen(ACCT.uid), []);
    assert.deepEqual(await store.listTenants(), []);
  });

  test("get returns null for an id this tenant never had", async () => {
    const store = new FirestoreOutboxStore();
    assert.equal(await store.get(ACCT.uid, "nope"), null);
  });

  test("a prune failure is swallowed — listOpen still answers", async () => {
    const store = new FirestoreOutboxStore();
    await store.append(event(ACCT.uid, "evt-live-2"));
    await store.append(event(ACCT.uid, "evt-gone"));
    docs.delete(`lisa-outbox/${ACCT.uid}/events/evt-gone`);

    const saved = globalThis.fetch;
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      // Fail only the index rewrite the prune attempts.
      if (
        String(url).includes(":commit") &&
        String(init?.body).includes(`lisa-outbox/${ACCT.uid}"`)
      ) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return saved(url, init);
    };
    try {
      // The reconciler must still see the live event: housekeeping that fails
      // is not allowed to hide work that needs doing.
      const open = await store.listOpen(ACCT.uid);
      assert.deepEqual(
        open.map((e) => e.id),
        ["evt-live-2"],
      );
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe("defaultOutboxStore", () => {
  test("picks the Firestore adapter only when Firestore is enabled", async () => {
    const before = process.env.LISA_FIRESTORE;
    try {
      process.env.LISA_FIRESTORE = "1";
      _resetOutboxStoreForTests();
      assert.ok(defaultOutboxStore() instanceof FirestoreOutboxStore);

      delete process.env.LISA_FIRESTORE;
      _resetOutboxStoreForTests();
      assert.ok(defaultOutboxStore() instanceof JsonlOutboxStore);
    } finally {
      if (before === undefined) delete process.env.LISA_FIRESTORE;
      else process.env.LISA_FIRESTORE = before;
      _resetOutboxStoreForTests();
    }
  });

  test("the adapter is memoized until a test resets it", () => {
    const a = defaultOutboxStore();
    assert.equal(defaultOutboxStore(), a);
    _resetOutboxStoreForTests();
    assert.notEqual(defaultOutboxStore(), a);
  });
});
