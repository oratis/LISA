/**
 * Single-session sign-out records (#493) on both account backends: the local
 * JSON directory and the Firestore document the hosted edition uses. The
 * Firestore runs go through the real REST client against an in-memory fake
 * (same shape as src/billing/outbox.firestore.test.ts).
 */
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-session-revocation-"));
process.env.LISA_HOME = dir;
process.env.LISA_FIRESTORE_PROJECT = "test-project";
delete process.env.LISA_FIRESTORE;
delete process.env.LISA_EDITION;

const { _resetFirestoreCachesForTests } = await import("../cloud/firestore.js");
const {
  ensureOtpAccount,
  getAccount,
  revokeSession,
  revokeAccountSessions,
  sessionAccountValid,
  sessionRevoked,
  MAX_REVOKED_SESSIONS,
} = await import("./accounts.js");
const { mintSession, verifySession, sessionId } = await import("./sessions-auth.js");

const DAY = 24 * 60 * 60 * 1000;

after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
      const docPath = w.update.name.split(`${docsBase}/`)[1]!;
      const existing = docs.get(docPath);
      const pre = w.currentDocument;
      if (pre?.updateTime !== undefined && existing?.updateTime !== pre.updateTime) {
        return new Response(JSON.stringify({ error: "precondition" }), { status: 409 });
      }
      if (pre?.exists === false && existing) {
        return new Response(JSON.stringify({ error: "exists" }), { status: 409 });
      }
      docs.set(docPath, { fields: w.update.fields, updateTime: `v${++version}` });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    const docPath = u.split(`${docsBase}/`)[1];
    if (docPath) {
      const doc = docs.get(docPath);
      if (!doc) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ fields: doc.fields, updateTime: doc.updateTime }), {
        status: 200,
      });
    }
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  return { fetchFn, docs };
}

function suite(backend: "json" | "firestore"): void {
  describe(`single-session sign-out on the ${backend} account store`, () => {
    let realFetch: typeof fetch;
    beforeEach(() => {
      if (backend !== "firestore") return;
      realFetch = globalThis.fetch;
      globalThis.fetch = fakeFirestore().fetchFn;
      process.env.LISA_FIRESTORE = "1";
      _resetFirestoreCachesForTests();
    });
    afterEach(() => {
      if (backend !== "firestore") return;
      globalThis.fetch = realFetch;
      delete process.env.LISA_FIRESTORE;
      _resetFirestoreCachesForTests();
    });

    test("revokes one session and keeps the account's others", async () => {
      const { acct } = await ensureOtpAccount(`one-${backend}@example.com`);
      const a = verifySession(mintSession(acct.uid, "s", { sv: acct.sessionVersion }), "s")!;
      const b = verifySession(mintSession(acct.uid, "s", { sv: acct.sessionVersion }), "s")!;
      assert.notEqual(sessionId(a), sessionId(b));
      assert.equal(await revokeSession(acct.uid, a.sv, sessionId(a), a.exp), true);
      assert.equal(await sessionAccountValid(acct.uid, a.sv, sessionId(a)), false);
      assert.equal(await sessionAccountValid(acct.uid, b.sv, sessionId(b)), true);
      // Callers that pass no id (console, older call sites) are unaffected.
      assert.equal(await sessionAccountValid(acct.uid, a.sv), true);
      // Idempotent.
      assert.equal(await revokeSession(acct.uid, a.sv, sessionId(a), a.exp), true);
      assert.equal((await getAccount(acct.uid))?.revokedSessions?.length, 1);
    });

    test("the cap invalidates the account version without reviving any revoked session", async () => {
      const { acct } = await ensureOtpAccount(`cap-${backend}@example.com`);
      const sv = acct.sessionVersion;
      const now = Date.now();
      for (let i = 0; i <= MAX_REVOKED_SESSIONS; i++) {
        assert.equal(await revokeSession(acct.uid, sv, `s${i}`, now + DAY, now), true);
      }
      const rec = (await getAccount(acct.uid))!;
      assert.equal(rec.sessionVersion, sv + 1);
      assert.equal(rec.revokedSessions, undefined);
      for (let i = 0; i <= MAX_REVOKED_SESSIONS; i++) {
        assert.equal(await sessionAccountValid(acct.uid, sv, `s${i}`), false);
      }
    });

    test("old-token logout covers newer renewals through their remaining lifetime", async () => {
      const { acct } = await ensureOtpAccount(`family-${backend}@example.com`);
      const now = Date.now();
      await revokeSession(acct.uid, acct.sessionVersion, "family", now + DAY, now);
      // Pruning after the old token expired must not restore a newer family token.
      await revokeSession(acct.uid, acct.sessionVersion, "other", now + 3 * DAY, now + 2 * DAY);
      assert.equal(sessionRevoked((await getAccount(acct.uid))!, "family"), true);
      await revokeSession(acct.uid, acct.sessionVersion, "later", now + 40 * DAY, now + 31 * DAY);
      assert.equal(sessionRevoked((await getAccount(acct.uid))!, "family"), false);
    });

    test("a stale session version or a missing account has nothing to revoke", async () => {
      const { acct } = await ensureOtpAccount(`stale-${backend}@example.com`);
      assert.equal(
        await revokeSession(acct.uid, acct.sessionVersion + 1, "x", Date.now() + DAY),
        false,
      );
      assert.equal(await revokeSession("em-missing", 0, "x", Date.now() + DAY), false);
    });

    test("signing out everywhere bumps the version and clears the records", async () => {
      const { acct } = await ensureOtpAccount(`all-${backend}@example.com`);
      await revokeSession(acct.uid, acct.sessionVersion, "x", Date.now() + DAY);
      await revokeAccountSessions(acct.uid);
      const rec = (await getAccount(acct.uid))!;
      assert.equal(rec.sessionVersion, acct.sessionVersion + 1);
      assert.equal(rec.revokedSessions, undefined);
      assert.equal(await sessionAccountValid(acct.uid, acct.sessionVersion, "y"), false);
    });
  });
}

before(() => {
  assert.ok(MAX_REVOKED_SESSIONS > 1);
});
suite("json");
suite("firestore");
