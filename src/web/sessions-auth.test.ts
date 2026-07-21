import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-sessions-"));
process.env.LISA_HOME = TMP;

const { mintSession, verifySession, looksLikeSession, shouldRenew, loadOrCreateSessionSecret, SESSION_TTL_MS } =
  await import("./sessions-auth.js");

const SECRET = "test-secret";
const T0 = 1_700_000_000_000;

describe("account sessions", () => {
  test("mint → verify round-trips uid/sv; token has the s1 shape", () => {
    const tok = mintSession("apple-001.abc", SECRET, { now: T0, sv: 3 });
    assert.ok(looksLikeSession(tok));
    const claims = verifySession(tok, SECRET, T0 + 1000);
    assert.equal(claims?.uid, "apple-001.abc");
    assert.equal(claims?.sv, 3);
    assert.equal(claims?.exp, T0 + SESSION_TTL_MS);
  });

  test("expired token → null; boundary is exclusive", () => {
    const tok = mintSession("u", SECRET, { now: T0, ttlMs: 1000 });
    assert.ok(verifySession(tok, SECRET, T0 + 999));
    assert.equal(verifySession(tok, SECRET, T0 + 1000), null);
  });

  test("wrong secret / tampered payload / garbage → null", () => {
    const tok = mintSession("u", SECRET, { now: T0 });
    assert.equal(verifySession(tok, "other-secret", T0), null);
    const parts = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "admin", iat: T0, exp: T0 + 9e9, sv: 0 }), "utf8").toString(
      "base64url",
    );
    assert.equal(verifySession(`${parts[0]}.${forged}.${parts[2]}`, SECRET, T0), null);
    assert.equal(verifySession("s1.not.athing", SECRET, T0), null);
    assert.equal(verifySession("", SECRET, T0), null);
    assert.equal(verifySession("lisa-demo-abcdef", SECRET, T0), null);
  });

  test("looksLikeSession distinguishes sessions from raw web tokens", () => {
    assert.equal(looksLikeSession("s1.x.y"), true);
    assert.equal(looksLikeSession("a1b2c3d4"), false);
  });

  test("shouldRenew flips past half-life", () => {
    const tok = mintSession("u", SECRET, { now: T0, ttlMs: 1000 });
    const claims = verifySession(tok, SECRET, T0 + 1)!;
    assert.equal(shouldRenew(claims, T0 + 400), false);
    assert.equal(shouldRenew(claims, T0 + 600), true);
  });

  test("secret auto-creates once, private (0600), and is stable across loads", { skip: process.platform === "win32" }, () => {
    const a = loadOrCreateSessionSecret();
    const b = loadOrCreateSessionSecret();
    assert.equal(a, b);
    assert.ok(a.length >= 64);
    const file = path.join(TMP, "session-secret");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
