import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyMailError } from "./connect-error.js";

/**
 * The exact error imapflow throws when Gmail rejects an app-password, captured
 * from a live imap.gmail.com:993 probe. Note `message` is a useless "Command
 * failed" — an earlier version keyed only on that and so fell through to the
 * generic branch, which defeated the whole point of the guided connect UI.
 */
function gmailAuthRejection(): Error {
  return Object.assign(new Error("Command failed"), {
    response: "3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)",
    responseStatus: "NO",
    executedCommand: "3 AUTHENTICATE PLAIN",
    responseText: "Invalid credentials (Failure)",
    serverResponseCode: "AUTHENTICATIONFAILED",
    authenticationFailed: true,
  });
}

test("real imapflow Gmail auth rejection → the app-password hint, not the generic branch", () => {
  const msg = friendlyMailError(gmailAuthRejection(), "me@gmail.com", "imap.gmail.com");
  assert.match(msg, /16-character app password/);
  assert.match(msg, /2-Step Verification/);
  assert.doesNotMatch(msg, /Command failed/);
});

test("auth rejection is detected from authenticationFailed alone", () => {
  // Same failure with every text clue stripped — the boolean must carry it.
  const bare = Object.assign(new Error("Command failed"), { authenticationFailed: true });
  const msg = friendlyMailError(bare, "me@qq.com", "imap.qq.com");
  assert.match(msg, /app-password \/ authorization code/);
});

test("non-Gmail auth failure gets the generic app-password wording", () => {
  const msg = friendlyMailError(gmailAuthRejection(), "me@qq.com", "imap.qq.com");
  assert.match(msg, /app-password \/ authorization code/);
  assert.doesNotMatch(msg, /Gmail/);
});

test("gmail is recognized by host even when the address is a custom domain", () => {
  const msg = friendlyMailError(gmailAuthRejection(), "me@mydomain.com", "imap.gmail.com");
  assert.match(msg, /Gmail rejected the sign-in/);
});

test("DNS failure → check-the-host hint", () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND imap.nope.invalid"), { code: "ENOTFOUND" });
  assert.match(friendlyMailError(dns, "me@nope.invalid", "imap.nope.invalid"), /Could not find the mail server/);
});

test("timeout → network hint", () => {
  const to = new Error("timed out reaching the mail server");
  assert.match(friendlyMailError(to, "me@x.com", "imap.x.com"), /network or timeout/);
});

test("unknown failure surfaces the server's own text, not \"Command failed\"", () => {
  const odd = Object.assign(new Error("Command failed"), { responseText: "Server busy, try later" });
  const msg = friendlyMailError(odd, "me@x.com", "imap.x.com");
  assert.match(msg, /Server busy, try later/);
  assert.doesNotMatch(msg, /Command failed/);
});

test("a non-Error value does not throw", () => {
  assert.ok(friendlyMailError("boom", "me@x.com", "imap.x.com").length > 0);
  assert.ok(friendlyMailError(undefined, "me@x.com", "imap.x.com").length > 0);
});
