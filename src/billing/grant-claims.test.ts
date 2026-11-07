/**
 * Welcome-grant claims on the hosted store (#447 review): Firestore, through
 * the real firestore client against an in-memory REST fake (the one the
 * outbox's Firestore tests use). The file store is covered by quota.test.ts.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AccountRecord } from "../web/accounts.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Never the real home, even if the Firestore switch below were missed.
process.env.LISA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-grant-claims-"));
process.env.LISA_FIRESTORE = "1";
process.env.LISA_FIRESTORE_PROJECT = "test-project";
delete process.env.LISA_FIRESTORE_TOKEN;

const { _resetFirestoreCachesForTests } = await import("../cloud/firestore.js");
const { claimWelcomeGrant, welcomeGrantClaimed, grantIdentityKeys } =
  await import("./grant-claims.js");

function fakeFirestore() {
  const docs = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  let version = 0;
  const docsBase = "/databases/(default)/documents";
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("metadata.google.internal")) {
      if (u.endsWith("/token"))
        return Response.json({ access_token: "tok", expires_in: 3600 }, { status: 200 });
      return new Response("test-project", { status: 200 });
    }
    if (u.includes(":commit")) {
      const body = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update: { name: string; fields: Record<string, unknown> };
          currentDocument?: { exists?: boolean; updateTime?: string };
        }>;
      };
      const w = body.writes[0]!;
      const path = w.update.name.split(`${docsBase}/`)[1]!;
      const existing = docs.get(path);
      const pre = w.currentDocument;
      if (pre?.updateTime !== undefined && existing?.updateTime !== pre.updateTime)
        return Response.json({ error: "precondition" }, { status: 409 });
      if (pre?.exists === false && existing)
        return Response.json({ error: "exists" }, { status: 409 });
      docs.set(path, { fields: w.update.fields, updateTime: `v${++version}` });
      return Response.json({});
    }
    const path = u.split(`${docsBase}/`)[1];
    const doc = path ? docs.get(path) : undefined;
    if (!doc) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ fields: doc.fields, updateTime: doc.updateTime });
  }) as typeof fetch;
  return { fetchFn, docs };
}

const person = (uid: string, extra: Partial<AccountRecord> = {}): AccountRecord => ({
  uid,
  kind: "apple",
  appleSub: "001.person",
  createdAt: 0,
  lastLoginAt: 0,
  verified: true,
  sessionVersion: 0,
  ...extra,
});

let realFetch: typeof fetch;
let docs: Map<string, { fields: Record<string, unknown>; updateTime: string }>;

beforeEach(() => {
  const fake = fakeFirestore();
  docs = fake.docs;
  realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchFn;
  _resetFirestoreCachesForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetFirestoreCachesForTests();
});

test("one grant per identity across accounts, stored as hashes", async () => {
  assert.equal(fs.existsSync(path.join(process.env.LISA_HOME!, "welcome-grants.json")), false);
  const first = person("apple-aaa", { email: "relay@privaterelay.appleid.com" });
  assert.equal(await welcomeGrantClaimed(first), false);
  assert.equal(await claimWelcomeGrant(first, 1), true);
  assert.equal(await welcomeGrantClaimed(first), true);
  // The same Apple ID after deleting the account: a new uid, no new grant.
  const again = person("apple-bbb");
  assert.equal(await claimWelcomeGrant(again, 2), false);
  // A different person is unaffected.
  assert.equal(await claimWelcomeGrant(person("apple-ccc", { appleSub: "002.other" }), 3), true);
  assert.equal(docs.size, 3);
  for (const doc of docs.keys()) {
    assert.match(doc, /^lisa-grant-claims\/[0-9a-f]{64}$/);
    assert.ok(!doc.includes("person") && !doc.includes("relay"));
  }
  // Firestore only: nothing was written to the file store.
  assert.equal(fs.existsSync(path.join(process.env.LISA_HOME!, "welcome-grants.json")), false);
});

test("identity keys: each sign-in method, the legacy Apple uid, and a stable email form", () => {
  const email = grantIdentityKeys(
    person("em-1", { kind: "email", appleSub: undefined, email: "A@B.co" }),
  );
  assert.deepEqual(
    email,
    grantIdentityKeys(person("em-2", { kind: "email", appleSub: undefined, email: " a@b.co " })),
  );
  // Legacy Apple uids encoded the subject in the uid itself.
  assert.deepEqual(
    grantIdentityKeys(person("apple-001.person", { appleSub: undefined })),
    grantIdentityKeys(person("apple-new")),
  );
  const google = grantIdentityKeys(
    person("g-1", { kind: "google", appleSub: undefined, googleSub: "42", email: "a@b.co" }),
  );
  assert.equal(google.length, 2);
  assert.ok(google.includes(email[0]!));
});
