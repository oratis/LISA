import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, templateSummary, formatDigestText } from "./digest.js";
import type { MailItem } from "./types.js";

function item(o: Partial<MailItem> = {}): MailItem {
  return {
    uid: "1",
    accountId: "acc",
    from: "Jane <jane@x.com>",
    fromAddress: "jane@x.com",
    subject: "hello",
    date: 1_700_000_000_000,
    snippet: "hi",
    category: "other",
    importance: 1,
    reason: "fyi",
    signals: [],
    classifiedAt: 1,
    ...o,
  };
}

test("buildDigest filters + sorts needsYou (importance>=2, importance then date)", () => {
  const items = [
    item({ uid: "a", importance: 1 }),
    item({ uid: "b", importance: 3, date: 100 }),
    item({ uid: "c", importance: 2, date: 200 }),
    item({ uid: "d", importance: 2, date: 300 }),
  ];
  const d = buildDigest(items, { date: "2026-06-25", accountIds: ["acc"], now: () => 5 });
  assert.equal(d.total, 4);
  assert.deepEqual(d.needsYou.map((i) => i.uid), ["b", "d", "c"]); // 3 first, then 2s newest-first
  assert.equal(d.generatedAt, 5);
});

test("buildDigest groups buckets and orders actionable categories first", () => {
  const items = [
    item({ uid: "1", category: "newsletter" }),
    item({ uid: "2", category: "newsletter" }),
    item({ uid: "3", category: "finance" }),
    item({ uid: "4", category: "urgent", importance: 3 }),
  ];
  const d = buildDigest(items, { date: "2026-06-25", accountIds: ["acc"] });
  assert.equal(d.buckets[0].category, "urgent"); // priority over the bigger newsletter bucket
  const nl = d.buckets.find((b) => b.category === "newsletter");
  assert.equal(nl?.count, 2);
});

test("templateSummary is empty-safe and lists who needs you", () => {
  assert.equal(templateSummary(0, [], []), "No new mail.");
  const s = templateSummary(3, [item({ subject: "Pay rent", importance: 3 })], [{ category: "finance", count: 1, items: [] }]);
  assert.match(s, /3 new emails/);
  assert.match(s, /1 needs you/);
  assert.match(s, /Pay rent/);
});

test("formatDigestText renders a compact push/chat body", () => {
  const d = buildDigest([item({ subject: "Sign the lease", importance: 3 })], { date: "2026-06-25", accountIds: ["acc"] });
  const txt = formatDigestText(d);
  assert.match(txt, /📬 Mail digest · 2026-06-25/);
  assert.match(txt, /Needs you:/);
  assert.match(txt, /Sign the lease/);
});
