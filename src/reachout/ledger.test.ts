import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateLedger,
  appendLedger,
  budgetShare,
  budgetUsed,
  hashText,
  netDismissals,
  noticeEntry,
  outcomeOf,
  readLedger,
  reachOutLedgerPath,
  sanitizeKind,
  seenRecently,
  type LedgerEntry,
  type LedgerNoticeEntry,
} from "./ledger.js";
import type { ReachOutDecision, ReachOutNotice } from "./types.js";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-ledger-"));
}

const NOW = new Date("2026-10-02T12:00:00Z");

function entry(patch: Partial<LedgerNoticeEntry> = {}): LedgerNoticeEntry {
  return {
    v: 1,
    type: "notice",
    id: `ro_${Math.random().toString(36).slice(2)}`,
    ts: NOW.toISOString(),
    day: "2026-10-02",
    source: "mail",
    kind: "digest",
    priority: "normal",
    solicited: false,
    outcome: "delivered",
    channels: ["inapp", "push"],
    reason: "ok",
    budget: true,
    titleHash: "0".repeat(16),
    titleLen: 4,
    bodyLen: 9,
    ...patch,
  };
}

test("noticeEntry records sizes and hashes, never the text", () => {
  const notice: ReachOutNotice = {
    uid: null,
    source: "mail",
    kind: "important",
    title: "Lunch with Priya?",
    body: "She asked about Thursday.",
    priority: "high",
    dedupeKey: "work:991",
  };
  const decision: ReachOutDecision = {
    deliver: true,
    channels: ["inapp"],
    reason: "quiet-hours",
    deferred: ["push"],
    deferUntil: "2026-10-03T08:00:00.000Z",
    countsBudget: true,
    score: 4,
  };
  const e = noticeEntry("ro_x", notice, decision, NOW, "UTC", false);
  const raw = JSON.stringify(e);
  assert.ok(!raw.includes("Priya") && !raw.includes("Thursday") && !raw.includes("work:991"));
  assert.equal(e.titleHash, hashText("Lunch with Priya?"));
  assert.equal(e.titleLen, 17);
  assert.equal(e.bodyLen, 25);
  assert.equal(e.dedupe, hashText("work:991"));
  assert.equal(e.outcome, "deferred");
  assert.equal(e.day, "2026-10-02");
  assert.equal(e.budget, true);
});

test("outcomeOf: delivered, deferred, dropped", () => {
  assert.equal(outcomeOf({ deliver: true, channels: ["inapp"], reason: "ok" }), "delivered");
  assert.equal(
    outcomeOf({ deliver: true, channels: ["inapp"], reason: "quiet-hours", deferred: ["push"] }),
    "deferred",
  );
  assert.equal(outcomeOf({ deliver: false, channels: [], reason: "duplicate" }), "dropped");
});

test("sanitizeKind keeps a short safe token", () => {
  assert.equal(sanitizeKind("Important Mail!!"), "important-mail");
  assert.equal(sanitizeKind("a".repeat(200)).length, 48);
  assert.equal(sanitizeKind(""), "unknown");
  assert.equal(sanitizeKind("../../etc/passwd"), "..-..-etc-passwd");
});

test("append → read round-trips; torn and foreign lines are skipped", async () => {
  const home = tmpHome();
  await appendLedger([entry({ id: "ro_a" }), entry({ id: "ro_b" })], home, NOW);
  fs.appendFileSync(reachOutLedgerPath(home), '{"v":1,"type":"notice","id":"ro_torn","ts":"2026\n');
  fs.appendFileSync(reachOutLedgerPath(home), "not json at all\n");
  fs.appendFileSync(reachOutLedgerPath(home), '{"type":"something-else","id":"x","ts":"y"}\n');
  await appendLedger([entry({ id: "ro_c" })], home, NOW);
  assert.deepEqual(
    readLedger(home).map((e) => e.id),
    ["ro_a", "ro_b", "ro_c"],
  );
});

test("a missing ledger reads as empty", () => {
  assert.deepEqual(readLedger(tmpHome()), []);
});

test("the ledger file is private to the user (0600)", async () => {
  const home = tmpHome();
  await appendLedger([entry()], home, NOW);
  assert.equal(fs.statSync(reachOutLedgerPath(home)).mode & 0o777, 0o600);
});

test("compaction keeps recent history once the file passes the size cap", async () => {
  const home = tmpHome();
  const old = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
  const filler: LedgerEntry[] = [];
  for (let i = 0; i < 5000; i++)
    filler.push(entry({ id: `ro_old${i}`, ts: old, day: "2026-06-04" }));
  await appendLedger(filler, home, NOW);
  await appendLedger([entry({ id: "ro_new" })], home, NOW);
  const kept = readLedger(home);
  assert.deepEqual(
    kept.map((e) => e.id),
    ["ro_new"],
  );
  assert.ok(fs.statSync(reachOutLedgerPath(home)).size < 2048);
});

test("budgetUsed counts only budget-consuming notices on that local day", () => {
  const entries: LedgerEntry[] = [
    entry(),
    entry({ budget: false, solicited: true }),
    entry({ day: "2026-10-01" }),
    entry({ outcome: "deferred", channels: ["inapp"], deferred: ["push"] }),
    {
      v: 1,
      type: "feedback",
      id: "x",
      ts: NOW.toISOString(),
      verdict: "useful",
      source: "mail",
      kind: "digest",
    },
  ];
  assert.equal(budgetUsed(entries, "2026-10-02"), 2);
  assert.equal(budgetUsed(entries, "2026-10-01"), 1);
  assert.equal(budgetUsed(entries, "2026-10-03"), 0);
});

test("seenRecently matches the hashed key inside the window and ignores dropped notices", () => {
  const key = "mail-digest:2026-10-02";
  const delivered = entry({ dedupe: hashText(key) });
  assert.equal(seenRecently([delivered], key, NOW), true);
  assert.equal(seenRecently([delivered], "other", NOW), false);
  assert.equal(seenRecently([delivered], undefined, NOW), false);
  assert.equal(seenRecently([delivered], key, new Date(NOW.getTime() + 25 * 3_600_000)), false);
  assert.equal(
    seenRecently([entry({ dedupe: hashText(key), outcome: "dropped" })], key, NOW),
    false,
  );
});

test("netDismissals: per source+kind, latest verdict per notice, floored at zero, windowed", () => {
  const fb = (id: string, verdict: "useful" | "dismissed", ts = NOW.toISOString(), kind = "note") =>
    ({ v: 1, type: "feedback", id, ts, verdict, source: "idle", kind }) as LedgerEntry;
  assert.equal(netDismissals([fb("a", "dismissed"), fb("b", "dismissed")], "idle", "note", NOW), 2);
  // Changing your mind on the same notice counts once.
  assert.equal(netDismissals([fb("a", "dismissed"), fb("a", "useful")], "idle", "note", NOW), 0);
  assert.equal(netDismissals([fb("a", "useful"), fb("b", "useful")], "idle", "note", NOW), 0);
  assert.equal(netDismissals([fb("a", "dismissed"), fb("b", "useful")], "idle", "note", NOW), 0);
  // Other kinds and sources do not count.
  assert.equal(
    netDismissals([fb("a", "dismissed", NOW.toISOString(), "other")], "idle", "note", NOW),
    0,
  );
  assert.equal(netDismissals([fb("a", "dismissed")], "mail", "note", NOW), 0);
  // Outside the 30-day window.
  const old = new Date(NOW.getTime() - 31 * 86_400_000).toISOString();
  assert.equal(netDismissals([fb("a", "dismissed", old)], "idle", "note", NOW), 0);
});

test("aggregateLedger: per-source outcomes, interruptions, and the useful rate", () => {
  const entries: LedgerEntry[] = [
    entry({ id: "m1" }),
    entry({ id: "m2", channels: ["inapp"], reason: "over-budget", budget: false }),
    entry({ id: "m3", outcome: "dropped", channels: [], reason: "duplicate", budget: false }),
    entry({
      id: "i1",
      source: "idle",
      kind: "note",
      outcome: "deferred",
      channels: ["inapp"],
      deferred: ["push"],
    }),
    entry({ id: "old", day: "2026-09-20", ts: "2026-09-20T12:00:00Z" }),
    {
      v: 1,
      type: "feedback",
      id: "m1",
      ts: NOW.toISOString(),
      verdict: "dismissed",
      source: "mail",
      kind: "digest",
    },
    {
      v: 1,
      type: "feedback",
      id: "m1",
      ts: NOW.toISOString(),
      verdict: "useful",
      source: "mail",
      kind: "digest",
    },
    {
      v: 1,
      type: "feedback",
      id: "i1",
      ts: NOW.toISOString(),
      verdict: "dismissed",
      source: "idle",
      kind: "note",
    },
    {
      v: 1,
      type: "feedback",
      id: "old",
      ts: NOW.toISOString(),
      verdict: "useful",
      source: "mail",
      kind: "digest",
    },
    { v: 1, type: "release", id: "i1", ts: NOW.toISOString(), channels: ["push"] },
  ];
  const agg = aggregateLedger(entries, 7, NOW, "UTC");
  assert.equal(agg.days, 7);
  assert.equal(agg.since, "2026-09-26");
  assert.deepEqual(agg.bySource.mail, {
    delivered: 2,
    deferred: 0,
    dropped: 1,
    interrupted: 1,
    useful: 1,
    dismissed: 0,
  });
  assert.deepEqual(agg.bySource.idle, {
    delivered: 0,
    deferred: 1,
    dropped: 0,
    interrupted: 1,
    useful: 0,
    dismissed: 1,
  });
  assert.equal(agg.totals.delivered, 2);
  assert.equal(agg.totals.dropped, 1);
  // 1 useful of the 3 notices that reached the user in the window.
  assert.equal(agg.usefulRate, 1 / 3);
  assert.equal(agg.budgetUsedToday, 2);

  const wide = aggregateLedger(entries, 30, NOW, "UTC");
  assert.equal(wide.bySource.mail.delivered, 3);
  assert.equal(wide.bySource.mail.useful, 2);
});

test("aggregateLedger clamps days and reports no rate when nothing reached the user", () => {
  const agg = aggregateLedger([], 9999, NOW, "UTC");
  assert.equal(agg.days, 90);
  assert.equal(agg.usefulRate, null);
  assert.equal(aggregateLedger([], 0, NOW, "UTC").days, 1);
});

test("budgetShare: paid once any member spent the unit, denied if the first was over budget", () => {
  const key = "mail-poll:2026-10-02T12:00";
  const h = hashText(key);
  assert.equal(budgetShare([], key, "2026-10-02"), null);
  assert.equal(budgetShare([entry({ budgetKey: h })], undefined, "2026-10-02"), null);
  assert.equal(budgetShare([entry({ budgetKey: h })], key, "2026-10-02"), "paid");
  assert.equal(budgetShare([entry({ budgetKey: h })], "another poll", "2026-10-02"), null);
  // Yesterday's unit does not carry over.
  assert.equal(budgetShare([entry({ budgetKey: h })], key, "2026-10-03"), null);
  const refused = entry({
    budgetKey: h,
    budget: false,
    reason: "over-budget",
    channels: ["inapp"],
  });
  assert.equal(budgetShare([refused], key, "2026-10-02"), "denied");
  // A member that never reached the budget check settles nothing.
  const quiet = entry({
    budgetKey: h,
    budget: false,
    reason: "below-value-bar",
    channels: ["inapp"],
  });
  assert.equal(budgetShare([quiet], key, "2026-10-02"), null);
  // Paid wins over an earlier refusal (cannot happen in one day, but be explicit).
  assert.equal(budgetShare([refused, entry({ budgetKey: h })], key, "2026-10-02"), "paid");
});
