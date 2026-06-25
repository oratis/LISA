import { test } from "node:test";
import assert from "node:assert/strict";
import { GmailConnector, gmailMessageToRaw, type HttpFetch } from "./gmail.js";
import type { MailAccount, MailSecret } from "../types.js";

function ok(payload: object): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}
function msg(id: string, subject: string, internalDate: string) {
  return {
    id,
    snippet: `snip ${id}`,
    internalDate,
    payload: { headers: [{ name: "From", value: "Jane <jane@x.com>" }, { name: "Subject", value: subject }] },
  };
}
function gmailFake(opts: { onToken?: () => void } = {}): HttpFetch {
  return async (url) => {
    if (url.includes("oauth2.googleapis.com/token")) { opts.onToken?.(); return ok({ access_token: "new-at", expires_in: 3600 }); }
    if (url.includes("/messages?")) return ok({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (url.includes("/messages/m1")) return ok(msg("m1", "Older", "1000"));
    if (url.includes("/messages/m2")) return ok(msg("m2", "Newer", "2000"));
    if (url.includes("/profile")) return ok({ emailAddress: "me@gmail.com" });
    return { ok: false, status: 404, text: async () => "nope" };
  };
}

const account: MailAccount = { id: "g1", provider: "gmail", email: "me@gmail.com", addedAt: 0, enabled: true };

test("gmailMessageToRaw maps headers, snippet, internalDate", () => {
  const r = gmailMessageToRaw(msg("x", "Hi", "1234"), "acc");
  assert.equal(r.uid, "x");
  assert.equal(r.subject, "Hi");
  assert.equal(r.date, 1234);
  assert.equal(r.fromAddress, "jane@x.com");
  assert.match(r.snippet, /snip x/);
});

test("listSince uses a valid token (no refresh) and returns newest-first", async () => {
  const secret: MailSecret = { refreshToken: "rt", clientId: "id", clientSecret: "s", accessToken: "valid", expiry: 9_999_999_999_999 };
  let tokenHit = false;
  const conn = new GmailConnector(account, secret, { fetchImpl: gmailFake({ onToken: () => (tokenHit = true) }), now: () => 1000 });
  const raws = await conn.listSince({ sinceMs: 0, limit: 10 });
  assert.equal(tokenHit, false); // token still valid ⇒ no refresh
  assert.equal(raws.length, 2);
  assert.equal(raws[0].uid, "m2"); // internalDate 2000 newer than 1000
  assert.equal(raws[0].subject, "Newer");
});

test("listSince refreshes an expired token and reports it", async () => {
  const secret: MailSecret = { refreshToken: "rt", clientId: "id", clientSecret: "s", accessToken: "old", expiry: 500 };
  let tokenHit = false;
  let refreshed = false;
  const conn = new GmailConnector(account, secret, {
    fetchImpl: gmailFake({ onToken: () => (tokenHit = true) }),
    onTokenRefresh: () => (refreshed = true),
    now: () => 1000, // > expiry 500 ⇒ refresh
  });
  const raws = await conn.listSince({ sinceMs: 0, limit: 10 });
  assert.equal(tokenHit, true);
  assert.equal(refreshed, true);
  assert.equal(raws.length, 2);
});

test("unauthorized account (no tokens) throws", async () => {
  const conn = new GmailConnector(account, { clientId: "id" }, { fetchImpl: gmailFake() });
  await assert.rejects(() => conn.listSince({ sinceMs: 0, limit: 10 }), /not authorized/);
});
