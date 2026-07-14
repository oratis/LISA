import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepAll, pollNewMail, probeAccount, type ConnectorFactory } from "./service.js";
import { addAccount } from "./accounts.js";
import { latestDigest } from "./store.js";
import { grant } from "../consent/store.js";
import type { Provider } from "../providers/types.js";
import type { MailAccount, MailConnector, MailSecret, RawMail } from "./types.js";

async function withHome(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.LISA_HOME;
  const home = mkdtempSync(join(tmpdir(), "lisa-mail-svc-"));
  process.env.LISA_HOME = home;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function raw(uid: string, o: Partial<RawMail> = {}): RawMail {
  return {
    uid,
    accountId: "",
    from: "Jane <jane@x.com>",
    fromAddress: "jane@x.com",
    subject: "hello",
    date: 1_700_000_000_000,
    snippet: "hi",
    flags: [],
    mailbox: "INBOX",
    ...o,
  };
}

function fakeConnector(raws: RawMail[]): ConnectorFactory {
  return (): MailConnector => ({
    async listSince() {
      return raws;
    },
    async close() {},
  });
}

/** Provider that always returns a fixed classification JSON. */
function fakeProvider(json: string): Provider {
  return {
    name: "fake",
    async runTurn() {
      return {
        content: [{ type: "text", text: json } as never],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("sweepAll is blocked when mail consent is not granted", async () => {
  await withHome(async () => {
    const res = await sweepAll({ connectorFactory: fakeConnector([raw("1")]), provider: fakeProvider("[]") });
    assert.equal(res.blocked, true);
    assert.equal(res.items.length, 0);
    assert.equal(res.digest.total, 0);
  });
});

test("sweepAll connects, classifies, builds + saves a digest", async () => {
  await withHome(async () => {
    grant("mail");
    addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "pw" });
    const raws = [
      raw("1", { subject: "Invoice due", flags: [] }),
      raw("2", { subject: "Weekly digest", flags: ["\\Seen"] }),
    ];
    const json =
      '[{"uid":"1","category":"finance","importance":3,"reason":"bill due"},' +
      '{"uid":"2","category":"newsletter","importance":0,"reason":"promo"}]';
    const res = await sweepAll({ connectorFactory: fakeConnector(raws), provider: fakeProvider(json) });

    assert.equal(res.blocked, undefined);
    assert.equal(res.items.length, 2);
    assert.equal(res.digest.total, 2);
    assert.equal(res.digest.unread, 1); // only uid 1 lacked \Seen
    assert.equal(res.digest.needsYou.length, 1);
    assert.equal(res.digest.needsYou[0].uid, "1");
    assert.equal(res.newItems.length, 2); // first sweep ⇒ both fresh

    // persisted
    const saved = latestDigest();
    assert.equal(saved?.total, 2);
  });
});

test("a second sweep marks nothing new (seen-uid dedup)", async () => {
  await withHome(async () => {
    grant("mail");
    addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "pw" });
    const raws = [raw("1", { subject: "Invoice" })];
    const json = '[{"uid":"1","category":"finance","importance":2,"reason":"x"}]';
    await sweepAll({ connectorFactory: fakeConnector(raws), provider: fakeProvider(json) });
    const second = await sweepAll({ connectorFactory: fakeConnector(raws), provider: fakeProvider(json) });
    assert.equal(second.items.length, 1); // still classified for the digest
    assert.equal(second.newItems.length, 0); // but nothing NEW
  });
});

test("pollNewMail returns only freshly-classified items and is empty on re-poll", async () => {
  await withHome(async () => {
    grant("mail");
    addAccount({ provider: "imap", email: "me@qq.com", host: "imap.qq.com" }, { password: "pw" });
    const raws = [raw("1", { subject: "Pay invoice" })];
    const json = '[{"uid":"1","category":"finance","importance":3,"reason":"due"}]';
    const first = await pollNewMail({ connectorFactory: fakeConnector(raws), provider: fakeProvider(json) });
    assert.equal(first.length, 1);
    assert.equal(first[0].importance, 3);
    const second = await pollNewMail({ connectorFactory: fakeConnector(raws), provider: fakeProvider(json) });
    assert.equal(second.length, 0); // already seen ⇒ no re-alert
  });
});

test("pollNewMail returns nothing without consent", async () => {
  await withHome(async () => {
    const res = await pollNewMail({ connectorFactory: fakeConnector([raw("1")]), provider: fakeProvider("[]") });
    assert.equal(res.length, 0);
  });
});

test("one failing account doesn't sink the sweep", async () => {
  await withHome(async () => {
    grant("mail");
    addAccount({ provider: "imap", email: "a@x.com", host: "imap.x.com" }, { password: "pw" });
    const boom: ConnectorFactory = () => ({
      async listSince() {
        throw new Error("auth failed");
      },
      async close() {},
    });
    const res = await sweepAll({ connectorFactory: boom, provider: fakeProvider("[]") });
    assert.equal(res.blocked, undefined);
    assert.equal(res.items.length, 0); // failed account contributed nothing, no throw
  });
});

test("probeAccount defers close until the probe settles — a slow success after the timeout is not leaked", async () => {
  let closed = 0;
  let resolveRun: (v: RawMail[]) => void = () => {};
  const runP = new Promise<RawMail[]>((res) => {
    resolveRun = res;
  });
  // A connector whose connect/list is slower than the timeout but eventually
  // succeeds — the exact race the 20s timeout exists for.
  const factory = (): MailConnector => ({
    listSince: () => runP,
    async close() {
      closed++;
    },
  });
  const acct: Pick<MailAccount, "provider" | "email" | "host" | "port"> = {
    provider: "imap",
    email: "me@x.com",
    host: "imap.x.com",
    port: 993,
  };
  const p = probeAccount(acct, { password: "pw" } as MailSecret, {
    connectorFactory: factory,
    timeoutMs: 20,
  });
  await assert.rejects(p, /timed out/);
  // The underlying op hasn't settled yet, so close must NOT have fired: closing
  // on the race (as the first cut did) would no-op here and leak the session
  // that listSince goes on to establish.
  assert.equal(closed, 0);
  resolveRun([]); // connect finally succeeds, late
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(closed, 1); // cleanup ran once the op actually settled
});
