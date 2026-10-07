import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { ImapConnector } from "./imap.js";

for (const date of [
  new Date("2026-10-01T12:00:00Z"),
  "2026-10-01T12:00:00Z",
  "invalid",
  undefined,
]) {
  test(`IMAP 2 envelope date ${String(date)} keeps a finite timestamp and read-only bounded fetch`, async (t) => {
    const msg: FetchMessageObject = {
      seq: 1,
      uid: 42,
      envelope: { date, subject: "Hello" },
      bodyStructure: { part: "1", type: "text/plain" },
    };
    let released = false;
    t.mock.method(ImapFlow.prototype, "connect", async () => {});
    t.mock.method(ImapFlow.prototype, "getMailboxLock", async (_path, options) => {
      assert.equal(options?.readOnly, true);
      return {
        path: "INBOX",
        release: () => {
          released = true;
        },
      };
    });
    t.mock.method(ImapFlow.prototype, "search", async () => [42]);
    t.mock.method(ImapFlow.prototype, "fetch", async function* (_range, query, options) {
      assert.equal(query.source, undefined);
      assert.equal(options?.uid, true);
      yield msg;
    });
    t.mock.method(ImapFlow.prototype, "download", async (_uid, _part, options) => {
      assert.equal(options?.maxBytes, 4096);
      return {
        meta: { expectedSize: 1000, contentType: "text/plain" },
        content: Readable.from(["x".repeat(1000)]),
      };
    });
    const connector = new ImapConnector(
      {
        id: "test",
        provider: "imap",
        email: "test@example.com",
        host: "imap.example.com",
        enabled: true,
        addedAt: 0,
      },
      { password: "test-only" },
    );
    const before = Date.now();
    const [mail] = await connector.listSince({ sinceMs: 0, limit: 1 });
    assert.ok(released);
    assert.ok(mail && Number.isFinite(mail.date));
    if (date && String(date) !== "invalid") assert.equal(mail.date, new Date(date).getTime());
    else assert.ok(mail.date >= before && mail.date <= Date.now());
    assert.equal(mail.snippet.length, 400);
    assert.equal(mail.fromAddress, "");
  });
}
