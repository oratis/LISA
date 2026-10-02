/**
 * No-regression proof for the senders that existed before the reach-out gate.
 *
 * For each one: under DEFAULT settings (no settings file at all), at an
 * ordinary time of day, routing it through the gate produces exactly the push
 * the sender produced before (same title, body, priority, tag — compared
 * against a direct call to the unchanged PushBridge method) and still posts
 * the in-app message.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { formatAlert } from "../mail/alerts.js";
import type { MailItem } from "../mail/types.js";
import { homeForUid, homeScope } from "../paths.js";
import { DeferQueue } from "../reachout/defer.js";
import { localMoment } from "../reachout/clock.js";
import { budgetUsed, readLedger } from "../reachout/ledger.js";
import type { ReachOutResult, StampedNotice } from "../reachout/types.js";
import { defaultPushPrefs, PushBridge, type PushEvent, type PushSubscription } from "./push.js";
import {
  advisorNotice,
  idleNoteNotice,
  kbBriefNotice,
  mailAlertNotice,
  mailDigestNotice,
  makeServerReachOut,
  reachOutApiOptions,
  scheduleServerCatchUp,
  type ServerReachOut,
} from "./reachout-wiring.js";

let home: string;
let previousHome: string | undefined;

// Local noon / local 23:30 — the default quiet hours follow the host zone.
const NOON = new Date(2026, 9, 2, 12, 0, 0);
const NIGHT = new Date(2026, 9, 2, 23, 30, 0);

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-wiring-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const SUB: PushSubscription = {
  id: "sub1",
  kind: "ntfy",
  target: "topic",
  prefs: defaultPushPrefs(),
  createdAt: 0,
};

interface Rig {
  bridge: PushBridge;
  pushed: PushEvent[];
  via: ServerReachOut;
  queue: DeferQueue;
}

function rig(now: Date = NOON, subs: PushSubscription[] = [SUB]): Rig {
  const pushed: PushEvent[] = [];
  // The bridge's own 30s per-key throttle is not under test: give each call
  // its own minute so two notes in one test are not collapsed by it.
  let calls = 0;
  const bridge = new PushBridge({
    subs: () => subs,
    deliver: (_sub, ev) => void pushed.push(ev),
    now: () => now.getTime() + calls++ * 60_000,
  });
  const queue = new DeferQueue({ tickMs: 0 });
  return {
    bridge,
    pushed,
    queue,
    via: makeServerReachOut({ pushBridge: bridge, now: () => now, deferQueue: queue }),
  };
}

/** What the sender pushed BEFORE the gate: a direct call on an identical bridge. */
function baseline(call: (bridge: PushBridge) => void): PushEvent[] {
  const { bridge, pushed } = rig();
  call(bridge);
  return pushed;
}

function assertDeliveredAsBefore(
  out: ReachOutResult,
  r: Rig,
  inapp: StampedNotice[],
  before: PushEvent[],
): void {
  assert.equal(out.deliver, true);
  assert.deepEqual(out.channels, ["inapp", "push"]);
  assert.equal(inapp.length, 1, "in-app message posted once");
  assert.equal(before.length, 1, "the pre-gate sender pushed once");
  assert.deepEqual(r.pushed, before, "push is identical to the pre-gate push");
  assert.equal(r.queue.size(), 0);
}

const MAIL_ITEM = {
  accountId: "acct1",
  uid: 42,
  from: '"Dana Wu" <dana@example.com>',
  subject: "Contract needs your signature today",
  date: 1,
  importance: 3,
  reason: "deadline today",
} as unknown as MailItem;

describe("pre-gate senders still deliver under default settings", () => {
  test("mail digest (scheduled daily run)", async () => {
    const text = "📬 12 mail · 2 need you\n• Dana: contract\n• Lee: invoice";
    const r = rig();
    const inapp: StampedNotice[] = [];
    const out = await r.via(
      mailDigestNotice({ text, date: "2026-10-02", needsYou: 2, manual: false }),
      { inapp: (n) => void inapp.push(n), push: () => r.bridge.onMailDigest(text) },
      { inapp: true },
    );
    assertDeliveredAsBefore(
      out,
      r,
      inapp,
      baseline((b) => b.onMailDigest(text)),
    );
    assert.equal(r.pushed[0]!.title, "📬 Mail digest");
  });

  test("mail digest (manual sweep): pushes as before, posts no chat message, spends no budget", async () => {
    const text = "📬 0 mail";
    const r = rig();
    const inapp: StampedNotice[] = [];
    const out = await r.via(
      mailDigestNotice({ text, date: "2026-10-02", needsYou: 0, manual: true }),
      { inapp: (n) => void inapp.push(n), push: () => r.bridge.onMailDigest(text) },
      { inapp: false },
    );
    assert.deepEqual(out.channels, ["push"]);
    assert.equal(out.reason, "solicited");
    assert.equal(inapp.length, 0);
    assert.deepEqual(
      r.pushed,
      baseline((b) => b.onMailDigest(text)),
    );
    assert.equal(out.countsBudget, undefined);
  });

  test("important-mail alert", async () => {
    const alert = formatAlert(MAIL_ITEM);
    const r = rig();
    const inapp: StampedNotice[] = [];
    const push = (b: PushBridge) =>
      b.onMailImportant({ title: alert.title, body: alert.body, tag: alert.tag });
    const out = await r.via(mailAlertNotice(alert, "poll-1"), {
      inapp: (n) => void inapp.push(n),
      push: () => push(r.bridge),
    });
    assertDeliveredAsBefore(out, r, inapp, baseline(push));
    assert.equal(r.pushed[0]!.priority, "high");
    assert.equal(out.countsBudget, true);
  });

  test("KB daily brief", async () => {
    const text = "📰 Brief 2026-10-02\n1. A paper on agents\n2. A release note";
    const r = rig();
    const inapp: StampedNotice[] = [];
    const out = await r.via(
      kbBriefNotice({ text, date: "2026-10-02", manual: false }),
      { inapp: (n) => void inapp.push(n), push: () => r.bridge.onKbBrief(text) },
      { inapp: true },
    );
    assertDeliveredAsBefore(
      out,
      r,
      inapp,
      baseline((b) => b.onKbBrief(text)),
    );
    assert.equal(r.pushed[0]!.title, "📰 Daily brief");
  });

  test("advisor digest (non-urgent, no action — the weakest case)", async () => {
    const text = "codex · api has been waiting on you for 20m";
    const r = rig();
    const inapp: StampedNotice[] = [];
    const out = await r.via(advisorNotice({ text, suggestions: [{ urgency: "notice" }] }), {
      inapp: (n) => void inapp.push(n),
      push: () => r.bridge.onIdleMessage(text),
    });
    assertDeliveredAsBefore(
      out,
      r,
      inapp,
      baseline((b) => b.onIdleMessage(text)),
    );
  });

  test("advisor digest (urgent)", async () => {
    const text = "⚠ two agents are editing the same file";
    const r = rig();
    const inapp: StampedNotice[] = [];
    const out = await r.via(
      advisorNotice({ text, suggestions: [{ urgency: "urgent", action: { kind: "x" } }] }),
      { inapp: (n) => void inapp.push(n), push: () => r.bridge.onIdleMessage(text) },
    );
    assertDeliveredAsBefore(
      out,
      r,
      inapp,
      baseline((b) => b.onIdleMessage(text)),
    );
  });

  test('idle "[while you were away]" note', async () => {
    const text = "I read the two papers you saved and linked them in the wiki.";
    const r = rig();
    const inapp: StampedNotice[] = [];
    const out = await r.via(idleNoteNotice(text), {
      inapp: (n) => void inapp.push(n),
      push: () => r.bridge.onIdleMessage(text),
    });
    assertDeliveredAsBefore(
      out,
      r,
      inapp,
      baseline((b) => b.onIdleMessage(text)),
    );
    assert.equal(r.pushed[0]!.title, "Lisa — while you were away");
  });

  test("idle note in Chinese keeps its localized push title", async () => {
    const text = "我把你存的两篇论文读完了，已经在知识库里互相链接。";
    const r = rig();
    const out = await r.via(idleNoteNotice(text), {
      inapp: () => {},
      push: () => r.bridge.onIdleMessage(text),
    });
    assert.deepEqual(out.channels, ["inapp", "push"]);
    assert.deepEqual(
      r.pushed,
      baseline((b) => b.onIdleMessage(text)),
    );
    assert.equal(r.pushed[0]!.title, "Lisa — 你不在的时候");
  });
});

describe("the daily budget is spent on what matters", () => {
  const used = (): number => budgetUsed(readLedger(home), localMoment(NOON, null).day);
  const digest = (r: Rig) =>
    r.via(mailDigestNotice({ text: "d", date: "2026-10-02", needsYou: 1, manual: false }), {
      inapp: () => {},
      push: () => r.bridge.onMailDigest("d"),
    });
  const brief = (r: Rig) =>
    r.via(kbBriefNotice({ text: "b", date: "2026-10-02", manual: false }), {
      inapp: () => {},
      push: () => r.bridge.onKbBrief("b"),
    });
  const idle = (r: Rig, text: string) =>
    r.via(idleNoteNotice(text), { inapp: () => {}, push: () => r.bridge.onIdleMessage(text) });
  const alert = (r: Rig, uid: number, pollKey: string) => {
    const a = formatAlert({ ...MAIL_ITEM, uid } as MailItem);
    return r.via(mailAlertNotice(a, pollKey), {
      inapp: () => {},
      push: () => r.bridge.onMailImportant({ title: a.title, body: a.body, tag: a.tag }),
    });
  };

  test("the scheduled digest and brief are solicited: they push without spending budget", async () => {
    const r = rig();
    for (const out of [await digest(r), await brief(r)]) {
      assert.deepEqual(out.channels, ["inapp", "push"]);
      assert.equal(out.reason, "solicited");
      assert.equal(out.countsBudget, undefined);
    }
    assert.equal(used(), 0);
  });

  test("digest + brief + idle note in one day do not block a later important-mail alert", async () => {
    const r = rig();
    await digest(r);
    await brief(r);
    assert.deepEqual((await idle(r, "n1")).channels, ["inapp", "push"]);
    const out = await alert(r, 1, "poll-14:00");
    assert.deepEqual(out.channels, ["inapp", "push"]);
    assert.equal(out.reason, "ok");
    assert.equal(used(), 2);
    assert.equal(r.pushed.length, 4);
    assert.equal(r.pushed[3]!.priority, "high");
  });

  test("three alerts from one poll all push and cost one unit", async () => {
    const r = rig();
    const outs = [await alert(r, 1, "p1"), await alert(r, 2, "p1"), await alert(r, 3, "p1")];
    for (const out of outs) assert.deepEqual(out.channels, ["inapp", "push"]);
    assert.deepEqual(
      outs.map((o) => o.countsBudget === true),
      [true, false, false],
    );
    assert.equal(used(), 1);
    assert.equal(r.pushed.length, 3);
    // Two units are still there for the rest of the day.
    assert.deepEqual((await idle(r, "n1")).channels, ["inapp", "push"]);
    assert.deepEqual((await idle(r, "n2")).channels, ["inapp", "push"]);
    assert.deepEqual((await idle(r, "n3")).channels, ["inapp"]);
  });

  test("alerts from two polls cost two units", async () => {
    const r = rig();
    await alert(r, 1, "p1");
    await alert(r, 2, "p1");
    assert.equal(used(), 1);
    await alert(r, 3, "p2");
    assert.equal(used(), 2);
    assert.deepEqual((await idle(r, "n1")).channels, ["inapp", "push"]);
    assert.equal(used(), 3);
    assert.equal((await alert(r, 4, "p3")).reason, "over-budget");
  });

  test("a poll that takes the last unit pushes all of its alerts", async () => {
    const r = rig();
    await idle(r, "n1");
    await idle(r, "n2");
    const outs = [await alert(r, 1, "p1"), await alert(r, 2, "p1"), await alert(r, 3, "p1")];
    for (const out of outs) assert.deepEqual(out.channels, ["inapp", "push"]);
    assert.equal(used(), 3);
  });

  test("a poll that arrives over budget stays in-app as a whole — the first alert decides", async () => {
    const r = rig();
    for (const n of ["n1", "n2", "n3"]) await idle(r, n);
    const outs = [await alert(r, 1, "p1"), await alert(r, 2, "p1")];
    for (const out of outs) {
      assert.deepEqual(out.channels, ["inapp"]);
      assert.equal(out.reason, "over-budget");
    }
    assert.equal(used(), 3);
  });
});

describe("what the gate changes for those senders (charter rules, on purpose)", () => {
  test("the 4th unsolicited push of the day stays in-app — the message itself is never lost", async () => {
    const r = rig();
    let posted = 0;
    const results: ReachOutResult[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await r.via(idleNoteNotice(`note ${i}`), {
          inapp: () => void posted++,
          push: () => r.bridge.onIdleMessage(`note ${i}`),
        }),
      );
    }
    assert.deepEqual(results[3]!.channels, ["inapp"]);
    assert.equal(results[3]!.reason, "over-budget");
    assert.equal(posted, 4);
    assert.equal(r.pushed.length, 3);
  });

  test("at night the note still appears in-app; its push waits for 08:00", async () => {
    const r = rig(NIGHT);
    let posted = 0;
    const out = await r.via(idleNoteNotice("late note"), {
      inapp: () => void posted++,
      push: () => r.bridge.onIdleMessage("late note"),
    });
    assert.deepEqual(out.channels, ["inapp"]);
    assert.deepEqual(out.deferred, ["push"]);
    assert.equal(posted, 1);
    assert.equal(r.pushed.length, 0);
    await r.queue.flushDue(new Date(2026, 9, 3, 8, 0, 0));
    assert.equal(r.pushed.length, 1);
    assert.equal(r.pushed[0]!.body, "late note");
  });

  test("the same scheduled digest is not sent twice in a day", async () => {
    const r = rig();
    const n = () => mailDigestNotice({ text: "d", date: "2026-10-02", needsYou: 0, manual: false });
    const t = { inapp: () => {}, push: () => r.bridge.onMailDigest("d") };
    assert.equal((await r.via(n(), t)).deliver, true);
    assert.equal((await r.via(n(), t)).reason, "duplicate");
    assert.equal(r.pushed.length, 1);
  });
});

describe("wiring", () => {
  test("no push subscription ⇒ in-app only, nothing recorded as pushed, no budget spent", async () => {
    const r = rig(NOON, []);
    let posted = 0;
    for (let i = 0; i < 5; i++) {
      const out = await r.via(idleNoteNotice(`n${i}`), {
        inapp: () => void posted++,
        push: () => r.bridge.onIdleMessage(`n${i}`),
      });
      assert.deepEqual(out.channels, ["inapp"]);
      assert.equal(out.reason, "ok");
    }
    assert.equal(posted, 5);
    assert.ok(readLedger(home).every((e) => e.type !== "notice" || !e.budget));
  });

  test("a notice raised inside a tenant's scope is decided in that tenant's home and never pushed", async () => {
    const r = rig();
    let posted = 0;
    const out = await homeScope.run(homeForUid("userA"), () =>
      r.via(idleNoteNotice("for A"), {
        inapp: () => void posted++,
        push: () => r.bridge.onIdleMessage("for A"),
      }),
    );
    // The machine-level push belongs to the operator, not to tenant A.
    assert.deepEqual(out.channels, ["inapp"]);
    assert.equal(posted, 1);
    assert.equal(r.pushed.length, 0);
    assert.equal(readLedger(homeForUid("userA")).length, 1);
    assert.equal(readLedger(home).length, 0);
  });

  test("API options: push is offered only to the local operator", () => {
    assert.equal(reachOutApiOptions(false).pushAvailable, true);
    assert.equal(reachOutApiOptions(true).pushAvailable, false);
    assert.equal(
      homeScope.run(homeForUid("userA"), () => reachOutApiOptions(false).pushAvailable),
      false,
    );
    assert.equal(reachOutApiOptions(false).imAvailable, false);
  });
});

describe("restart during quiet hours", () => {
  test("the server's catch-up sends one content-free push through the real bridge at 08:00", async () => {
    const before = rig(NIGHT);
    const out = await before.via(idleNoteNotice("PRIVATE note text"), {
      inapp: () => {},
      push: () => before.bridge.onIdleMessage("PRIVATE note text"),
    });
    assert.deepEqual(out.deferred, ["push"]);
    // Restart: a new bridge and a new (empty) in-memory queue.
    const restartAt = new Date(2026, 9, 3, 1, 0, 0);
    const after = rig(restartAt);
    assert.equal(
      scheduleServerCatchUp({
        pushBridge: after.bridge,
        now: () => restartAt,
        deferQueue: after.queue,
      }),
      1,
    );
    assert.equal(after.pushed.length, 0);
    await after.queue.flushDue(new Date(2026, 9, 3, 8, 0, 0));
    assert.equal(after.pushed.length, 1);
    assert.equal(after.pushed[0]!.title, "Lisa");
    assert.equal(after.pushed[0]!.body, "1 update while you were in quiet hours");
    assert.equal(after.pushed[0]!.pref, "idle");
    assert.doesNotMatch(JSON.stringify(after.pushed), /PRIVATE/);
    // A second restart finds nothing left to announce.
    const again = rig(new Date(2026, 9, 3, 9, 0, 0));
    assert.equal(scheduleServerCatchUp({ pushBridge: again.bridge, deferQueue: again.queue }), 0);
  });

  test("a clean start queues nothing, and a broken home cannot stop the server starting", () => {
    const r = rig();
    assert.equal(scheduleServerCatchUp({ pushBridge: r.bridge, deferQueue: r.queue }), 0);
    assert.equal(r.queue.size(), 0);
    fs.mkdirSync(path.join(home, "reachout"), { recursive: true });
    fs.mkdirSync(path.join(home, "reachout", "ledger.jsonl")); // a directory where the file should be
    assert.equal(scheduleServerCatchUp({ pushBridge: r.bridge, deferQueue: r.queue }), 0);
  });
});
