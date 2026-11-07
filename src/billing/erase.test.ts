import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LISA_FIRESTORE_PROJECT = "test-project";
process.env.LISA_FIRESTORE_TOKEN = "tok";

const { eraseAccountBilling } = await import("./erase.js");

/** A Firestore REST stand-in that supports list (GET on a collection) and DELETE. */
function fakeFirestore(initial: string[]) {
  const docs = new Set(initial);
  const deleted: string[] = [];
  const root = "/databases/(default)/documents/";
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = decodeURIComponent(u.pathname.split(root)[1] ?? "");
    if (init?.method === "DELETE") {
      docs.delete(path);
      deleted.push(path);
      return new Response("{}", { status: 200 });
    }
    // A collection path has an odd number of segments.
    if (path.split("/").length % 2 === 1) {
      const documents = [...docs]
        .filter(
          (d) => d.startsWith(path + "/") && d.split("/").length === path.split("/").length + 1,
        )
        .map((d) => ({ name: `projects/test-project/databases/(default)/documents/${d}` }));
      return new Response(JSON.stringify({ documents }), { status: 200 });
    }
    return new Response("{}", { status: docs.has(path) ? 200 : 404 });
  }) as typeof fetch;
  return { fetchFn, docs, deleted };
}

test("account deletion removes the balance, outbox and alerts, keeping transaction records", async () => {
  process.env.LISA_FIRESTORE = "1";
  try {
    const fs = fakeFirestore([
      "lisa-balances/u1",
      "lisa-balances/u2",
      "lisa-outbox/u1",
      "lisa-outbox/u1/events/e1",
      "lisa-outbox/u1/events/e2",
      "lisa-outbox/u2/events/e3",
      "lisa-anomaly-alerts/u1_2026-11-01",
      "lisa-anomaly-alerts/u10_2026-11-01",
      "lisa-txindex/tx-1",
      "lisa-outbox-tenants/3",
    ]);
    await eraseAccountBilling("u1", fs.fetchFn);
    assert.deepEqual([...fs.docs].sort(), [
      "lisa-anomaly-alerts/u10_2026-11-01",
      "lisa-balances/u2",
      "lisa-outbox-tenants/3",
      "lisa-outbox/u2/events/e3",
      "lisa-txindex/tx-1",
    ]);
  } finally {
    delete process.env.LISA_FIRESTORE;
  }
});

test("file mode leaves Firestore alone", async () => {
  delete process.env.LISA_FIRESTORE;
  const fs = fakeFirestore(["lisa-balances/u1"]);
  await eraseAccountBilling("u1", fs.fetchFn);
  assert.deepEqual(fs.deleted, []);
});
