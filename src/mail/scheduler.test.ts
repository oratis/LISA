import { test } from "node:test";
import assert from "node:assert/strict";
import { isDigestDue, digestHour, DEFAULT_DIGEST_HOUR } from "./scheduler.js";

test("isDigestDue: not due if already produced today", () => {
  const now = new Date(2026, 5, 25, 9, 0); // local Jun 25 2026, 09:00
  assert.equal(isDigestDue("2026-06-25", now, 8), false);
});

test("isDigestDue: due once past the target hour on a new day", () => {
  const now = new Date(2026, 5, 25, 9, 0);
  assert.equal(isDigestDue("2026-06-24", now, 8), true);
  assert.equal(isDigestDue(null, now, 8), true);
});

test("isDigestDue: not due before the target hour", () => {
  const now = new Date(2026, 5, 25, 7, 30);
  assert.equal(isDigestDue("2026-06-24", now, 8), false);
});

test("digestHour: env override within range, else default", () => {
  assert.equal(digestHour({ LISA_MAIL_DIGEST_HOUR: "6" } as NodeJS.ProcessEnv), 6);
  assert.equal(digestHour({} as NodeJS.ProcessEnv), DEFAULT_DIGEST_HOUR);
  assert.equal(digestHour({ LISA_MAIL_DIGEST_HOUR: "99" } as NodeJS.ProcessEnv), DEFAULT_DIGEST_HOUR);
  assert.equal(digestHour({ LISA_MAIL_DIGEST_HOUR: "nope" } as NodeJS.ProcessEnv), DEFAULT_DIGEST_HOUR);
});
