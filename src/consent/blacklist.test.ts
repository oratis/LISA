import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isBlacklistedApp,
  isBlacklistedPath,
  containsPII,
  redactPII,
} from "./blacklist.js";

describe("isBlacklistedApp", () => {
  test("matches password managers / finance, case-insensitive substring", () => {
    assert.equal(isBlacklistedApp("1Password 8"), true);
    assert.equal(isBlacklistedApp("Chase Banking"), true);
    assert.equal(isBlacklistedApp("Coinbase"), true);
    assert.equal(isBlacklistedApp("Visual Studio Code"), false);
    assert.equal(isBlacklistedApp(undefined), false);
  });
  test("honors user-supplied extras", () => {
    assert.equal(isBlacklistedApp("My Diary", ["diary"]), true);
  });
});

describe("isBlacklistedPath", () => {
  test("matches secrets / keys / credentials", () => {
    assert.equal(isBlacklistedPath("/home/me/.env"), true);
    assert.equal(isBlacklistedPath("/home/me/project/.env.local"), true);
    assert.equal(isBlacklistedPath("/keys/server.pem"), true);
    assert.equal(isBlacklistedPath("/home/me/.ssh/id_rsa"), true);
    assert.equal(isBlacklistedPath("/secrets/db.txt"), true);
    assert.equal(isBlacklistedPath("/home/me/notes.md"), false);
    assert.equal(isBlacklistedPath(undefined), false);
  });
});

describe("PII detection + redaction", () => {
  test("containsPII detects email / ssn / card; clean text → false", () => {
    assert.equal(containsPII("ping me at a@b.com"), true);
    assert.equal(containsPII("ssn 123-45-6789"), true);
    assert.equal(containsPII("card 4111 1111 1111 1111"), true);
    assert.equal(containsPII("nothing sensitive here"), false);
  });

  test("redactPII replaces with typed placeholders and is repeatable (no /g lastIndex leak)", () => {
    const t = "mail a@b.com and c@d.org";
    assert.equal(redactPII(t), "mail [email] and [email]");
    assert.equal(redactPII(t), "mail [email] and [email]"); // second call identical
    assert.ok(!containsPII(redactPII("ssn 123-45-6789")), "redacted text has no PII");
  });
});
