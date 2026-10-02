import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeForUid, homeScope } from "../paths.js";
import { DeferQueue } from "./defer.js";
import {
  VALUE_BAR,
  decideReachOut,
  effectiveDial,
  homeForNotice,
  reachOut,
  valueScore,
  type GateContext,
  type ReachOutDeps,
} from "./gate.js";
import { readLedger, reachOutLedgerPath, recordReachOutFeedback } from "./ledger.js";
import {
  DAILY_BUDGET,
  defaultReachOutSettings,
  reachOutSettingsPath,
  saveReachOutSettings,
  type ReachOutSettings,
} from "./settings.js";
import {
  REACH_OUT_DIALS,
  REACH_OUT_PRIORITIES,
  REACH_OUT_SOURCES,
  type ReachOutChannel,
  type ReachOutNotice,
  type ReachOutSource,
  type StampedNotice,
} from "./types.js";

// Every test pins the zone to UTC so the host's zone cannot change a result.
const NOON = new Date("2026-10-02T12:00:00Z");
const NIGHT = new Date("2026-10-02T23:30:00Z");

function utcSettings(patch: Partial<ReachOutSettings> = {}): ReachOutSettings {
  const s = defaultReachOutSettings();
  s.quietHours.tz = "UTC";
  return { ...s, ...patch };
}

function notice(patch: Partial<ReachOutNotice> = {}): ReachOutNotice {
  return {
    uid: null,
    source: "mail",
    kind: "digest",
    title: "Mail digest",
    body: "3 new messages",
    priority: "normal",
    ...patch,
  };
}

function ctx(patch: Partial<GateContext> = {}): GateContext {
  return {
    settings: utcSettings(),
    now: NOON,
    budgetUsed: 0,
    duplicate: false,
    dismissals: 0,
    proactiveMode: true,
    available: { inapp: true, push: true, im: true },
    ...patch,
  };
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-gate-"));
}

interface Recorder {
  deps: ReachOutDeps;
  inapp: StampedNotice[];
  push: Array<{ notice: StampedNotice; silent: boolean }>;
  queue: DeferQueue;
  logs: string[];
}

function recorder(home: string, now: Date, patch: Partial<ReachOutDeps> = {}): Recorder {
  const inapp: StampedNotice[] = [];
  const push: Array<{ notice: StampedNotice; silent: boolean }> = [];
  const logs: string[] = [];
  const queue = new DeferQueue({ tickMs: 0 });
  return {
    inapp,
    push,
    queue,
    logs,
    deps: {
      home,
      now: () => now,
      proactiveMode: () => true,
      deferQueue: queue,
      log: (m) => logs.push(m),
      transports: {
        inapp: (n) => void inapp.push(n),
        push: (n, o) => void push.push({ notice: n, silent: o.silent }),
      },
      ...patch,
    },
  };
}

async function homeWith(patch: (s: ReachOutSettings) => void = () => {}): Promise<string> {
  const home = tmpHome();
  const s = utcSettings();
  patch(s);
  await saveReachOutSettings(s, home);
  return home;
}

// ── the pure rule ──────────────────────────────────────────────────────────

test("default settings, daytime: an unsolicited notice goes in-app + push and spends budget", () => {
  const d = decideReachOut(notice(), ctx());
  assert.deepEqual(d.channels, ["inapp", "push"]);
  assert.equal(d.reason, "ok");
  assert.equal(d.countsBudget, true);
  assert.equal(d.deliver, true);
});

test("gate matrix: dial × source × quiet × budget × solicited × priority", () => {
  let cases = 0;
  for (const dial of REACH_OUT_DIALS) {
    for (const source of REACH_OUT_SOURCES) {
      for (const now of [NOON, NIGHT]) {
        for (const overBudget of [false, true]) {
          for (const solicitedFlag of [undefined, true, false] as const) {
            for (const priority of REACH_OUT_PRIORITIES) {
              cases++;
              const n = notice({ source, priority, solicited: solicitedFlag });
              const d = decideReachOut(
                n,
                ctx({
                  settings: utcSettings({ dial }),
                  now,
                  budgetUsed: overBudget ? DAILY_BUDGET[dial] : 0,
                }),
              );
              const label = JSON.stringify({
                dial,
                source,
                now,
                overBudget,
                solicitedFlag,
                priority,
              });
              const quiet = now === NIGHT;
              const always = source === "approval" || priority === "critical";
              const solicited = solicitedFlag ?? (source === "task" || source === "watcher");

              // In-app is the baseline: every source is on, so it is always there.
              assert.ok(d.channels.includes("inapp"), `in-app missing: ${label}`);
              // IM is off by default and must never appear.
              assert.ok(!d.channels.includes("im") && !d.deferred?.includes("im"), label);

              if (always) {
                assert.deepEqual(d.channels, ["inapp", "push"], label);
                assert.equal(d.reason, "always-deliver", label);
                assert.equal(d.silent === true, quiet, label);
                assert.equal(d.countsBudget, undefined, label);
                continue;
              }

              const passesValue = valueScore(n, 0) >= VALUE_BAR;
              const eligible =
                dial !== "off" &&
                (solicited || (source !== "desire" && passesValue && !overBudget));
              const pushNow = d.channels.includes("push");
              const pushLater = d.deferred?.includes("push") === true;

              assert.equal(pushNow, eligible && !quiet, `push now: ${label}`);
              assert.equal(pushLater, eligible && quiet, `push deferred: ${label}`);
              assert.equal(Boolean(d.deferUntil), pushLater, label);
              // Budget is spent exactly when an unsolicited notice gets to interrupt.
              assert.equal(d.countsBudget === true, eligible && !solicited, `budget: ${label}`);
              assert.notEqual(d.silent, true, label);

              if (dial === "off") assert.equal(d.reason, "dial-off", label);
              else if (pushLater) assert.equal(d.reason, "quiet-hours", label);
              else if (solicited) assert.equal(d.reason, "solicited", label);
              else if (source === "desire") assert.equal(d.reason, "desire-in-app-only", label);
              else if (!passesValue) assert.equal(d.reason, "below-value-bar", label);
              else if (overBudget) assert.equal(d.reason, "over-budget", label);
              else assert.equal(d.reason, "ok", label);
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 4 * 9 * 2 * 2 * 3 * 4);
});

test("dial off keeps everything in-app, except approvals and critical notices", () => {
  const settings = utcSettings({ dial: "off" });
  assert.deepEqual(decideReachOut(notice(), ctx({ settings })).channels, ["inapp"]);
  assert.deepEqual(
    decideReachOut(notice({ source: "task", solicited: true }), ctx({ settings })).channels,
    ["inapp"],
  );
  assert.deepEqual(decideReachOut(notice({ source: "approval" }), ctx({ settings })).channels, [
    "inapp",
    "push",
  ]);
  assert.deepEqual(
    decideReachOut(notice({ source: "system", priority: "critical" }), ctx({ settings })).channels,
    ["inapp", "push"],
  );
});

test("budget per dial: low 1, normal 3, high 8 — the next one stays in-app", () => {
  for (const dial of ["low", "normal", "high"] as const) {
    const settings = utcSettings({ dial });
    const last = decideReachOut(notice(), ctx({ settings, budgetUsed: DAILY_BUDGET[dial] - 1 }));
    assert.deepEqual(last.channels, ["inapp", "push"], dial);
    const over = decideReachOut(notice(), ctx({ settings, budgetUsed: DAILY_BUDGET[dial] }));
    assert.deepEqual(over.channels, ["inapp"], dial);
    assert.equal(over.reason, "over-budget");
    assert.equal(over.countsBudget, undefined);
  }
});

test("solicited results ignore the budget and the value gate", () => {
  const d = decideReachOut(
    notice({ source: "task", kind: "routine", priority: "low" }),
    ctx({ budgetUsed: 99, dismissals: 50 }),
  );
  assert.deepEqual(d.channels, ["inapp", "push"]);
  assert.equal(d.reason, "solicited");
  assert.equal(d.countsBudget, undefined);
});

test("quiet hours: unsolicited and solicited pushes wait for 08:00; approvals go out silent", () => {
  const unsolicited = decideReachOut(notice(), ctx({ now: NIGHT }));
  assert.deepEqual(unsolicited.channels, ["inapp"]);
  assert.deepEqual(unsolicited.deferred, ["push"]);
  assert.equal(unsolicited.deferUntil, "2026-10-03T08:00:00.000Z");
  assert.equal(unsolicited.countsBudget, true);

  const solicited = decideReachOut(notice({ source: "watcher" }), ctx({ now: NIGHT }));
  assert.deepEqual(solicited.deferred, ["push"]);
  assert.equal(solicited.countsBudget, undefined);

  const approval = decideReachOut(notice({ source: "approval" }), ctx({ now: NIGHT }));
  assert.deepEqual(approval.channels, ["inapp", "push"]);
  assert.equal(approval.silent, true);
  assert.equal(approval.deferred, undefined);
});

test("quiet hours can be switched off", () => {
  const settings = utcSettings();
  settings.quietHours.enabled = false;
  assert.deepEqual(decideReachOut(notice(), ctx({ settings, now: NIGHT })).channels, [
    "inapp",
    "push",
  ]);
});

test("a source switched off is dropped entirely; approval cannot be", () => {
  const settings = utcSettings();
  settings.sources.mail = false;
  settings.sources.system = false;
  const d = decideReachOut(notice(), ctx({ settings }));
  assert.equal(d.deliver, false);
  assert.equal(d.reason, "source-off");
  // critical beats the switch
  assert.deepEqual(
    decideReachOut(notice({ source: "system", priority: "critical" }), ctx({ settings })).channels,
    ["inapp", "push"],
  );
  assert.equal(
    decideReachOut(notice({ source: "system" }), ctx({ settings })).reason,
    "source-off",
  );
});

test("desire notes stay in-app until the user opts into desire push", () => {
  const n = notice({ source: "desire", kind: "progress" });
  assert.deepEqual(decideReachOut(n, ctx()).channels, ["inapp"]);
  assert.equal(decideReachOut(n, ctx()).reason, "desire-in-app-only");
  const opted = decideReachOut(n, ctx({ settings: utcSettings({ desirePush: true }) }));
  assert.deepEqual(opted.channels, ["inapp", "push"]);
  assert.equal(opted.countsBudget, true);
});

test("value gate: low-priority asides do not push; dismissals mute a kind; high priority survives one", () => {
  assert.equal(decideReachOut(notice({ priority: "low" }), ctx()).reason, "below-value-bar");
  assert.equal(decideReachOut(notice({ priority: "low", actionable: true }), ctx()).reason, "ok");
  assert.equal(decideReachOut(notice(), ctx({ dismissals: 1 })).reason, "below-value-bar");
  assert.equal(decideReachOut(notice({ priority: "high" }), ctx({ dismissals: 1 })).reason, "ok");
  const muted = decideReachOut(
    notice({ priority: "high", actionable: true }),
    ctx({ dismissals: 4 }),
  );
  assert.equal(muted.reason, "below-value-bar");
  assert.deepEqual(muted.channels, ["inapp"]);
});

test("red lines are denied on every channel, whatever the source or priority", () => {
  for (const source of REACH_OUT_SOURCES) {
    for (const priority of REACH_OUT_PRIORITIES) {
      const a = decideReachOut(notice({ source, priority, requestsDataConnection: true }), ctx());
      assert.deepEqual([a.deliver, a.channels, a.reason], [false, [], "red-line:data-connection"]);
      const b = decideReachOut(notice({ source, priority, emotionalPressure: true }), ctx());
      assert.deepEqual(
        [b.deliver, b.channels, b.reason],
        [false, [], "red-line:emotional-pressure"],
      );
    }
  }
});

test("a duplicate is dropped, even for an approval", () => {
  assert.equal(decideReachOut(notice(), ctx({ duplicate: true })).reason, "duplicate");
  assert.equal(
    decideReachOut(notice({ source: "approval" }), ctx({ duplicate: true })).deliver,
    false,
  );
});

test("an empty notice is dropped", () => {
  assert.equal(decideReachOut(notice({ title: " ", body: "" }), ctx()).reason, "empty");
});

test("no push transport (cloud): in-app still delivers and no budget is spent", () => {
  const d = decideReachOut(notice(), ctx({ available: { inapp: true, push: false, im: false } }));
  assert.deepEqual(d.channels, ["inapp"]);
  assert.equal(d.reason, "ok");
  assert.equal(d.countsBudget, undefined);
  const approval = decideReachOut(
    notice({ source: "approval" }),
    ctx({ available: { inapp: true, push: false, im: false } }),
  );
  assert.deepEqual(approval.channels, ["inapp"]);
});

test("channel preferences: push off ⇒ in-app only; IM on ⇒ treated like push", () => {
  const noPush = utcSettings();
  noPush.channels.push = false;
  assert.deepEqual(decideReachOut(notice(), ctx({ settings: noPush })).channels, ["inapp"]);
  const withIm = utcSettings();
  withIm.channels.im = true;
  assert.deepEqual(decideReachOut(notice(), ctx({ settings: withIm })).channels, [
    "inapp",
    "push",
    "im",
  ]);
  assert.deepEqual(decideReachOut(notice(), ctx({ settings: withIm, now: NIGHT })).deferred, [
    "push",
    "im",
  ]);
});

test("Proactive mode off silences only the sources unattended runs produce", () => {
  const s = utcSettings();
  for (const source of REACH_OUT_SOURCES) {
    const expected = source === "idle" || source === "desire" ? "off" : "normal";
    assert.equal(effectiveDial(s, source, false), expected, source);
    assert.equal(effectiveDial(s, source, true), "normal", source);
  }
  assert.deepEqual(
    decideReachOut(notice({ source: "idle", kind: "note" }), ctx({ proactiveMode: false }))
      .channels,
    ["inapp"],
  );
  // Mail keeps pushing: Proactive mode never governed it.
  assert.deepEqual(decideReachOut(notice(), ctx({ proactiveMode: false })).channels, [
    "inapp",
    "push",
  ]);
});

// ── reachOut(): settings + ledger + delivery ───────────────────────────────

test("reachOut delivers, stamps the notice as from Lisa, and returns a ledger id", async () => {
  const home = await homeWith();
  const r = recorder(home, NOON);
  const out = await reachOut(notice(), r.deps);
  assert.match(out.id, /^ro_/);
  assert.deepEqual(out.channels, ["inapp", "push"]);
  assert.equal(r.inapp.length, 1);
  assert.equal(r.push.length, 1);
  for (const n of [r.inapp[0]!, r.push[0]!.notice]) {
    assert.equal(n.from, "Lisa");
    assert.equal(n.ai, true);
    assert.equal(n.id, out.id);
  }
  assert.equal(r.push[0]!.silent, false);
});

test("the daily budget is enforced across calls and resets at local midnight (in the user's zone)", async () => {
  const home = await homeWith((s) => {
    s.quietHours.enabled = false;
    s.quietHours.tz = "Asia/Shanghai"; // UTC+8, no DST
  });
  const at = (iso: string) => recorder(home, new Date(iso));
  const send = async (iso: string, i: number) =>
    (await reachOut(notice({ kind: "note", title: `t${i}` }), at(iso).deps)).channels;

  // 2026-10-02 in Shanghai. Three pushes, then in-app only.
  assert.deepEqual(await send("2026-10-02T01:00:00Z", 1), ["inapp", "push"]); // 09:00 local
  assert.deepEqual(await send("2026-10-02T05:00:00Z", 2), ["inapp", "push"]);
  assert.deepEqual(await send("2026-10-02T09:00:00Z", 3), ["inapp", "push"]);
  assert.deepEqual(await send("2026-10-02T15:00:00Z", 4), ["inapp"]); // 23:00 local, over budget
  // 15:59 UTC is still 23:59 on the 2nd in Shanghai…
  assert.deepEqual(await send("2026-10-02T15:59:00Z", 5), ["inapp"]);
  // …and 16:00 UTC is 00:00 on the 3rd: the budget is back, though UTC's day has not turned.
  assert.deepEqual(await send("2026-10-02T16:00:00Z", 6), ["inapp", "push"]);
});

test("solicited notices and approvals never spend the budget", async () => {
  const home = await homeWith();
  for (let i = 0; i < 5; i++) {
    const r = recorder(home, NOON);
    await reachOut(notice({ source: "task", kind: "routine", title: `r${i}` }), r.deps);
    await reachOut(notice({ source: "approval", kind: "tool", title: `a${i}` }), r.deps);
    assert.equal(r.push.length, 2);
  }
  const r = recorder(home, NOON);
  assert.deepEqual((await reachOut(notice(), r.deps)).channels, ["inapp", "push"]);
});

test("dedupe: the same key inside the window is dropped; a new key or a later day is not", async () => {
  const home = await homeWith();
  const first = recorder(home, NOON);
  assert.equal((await reachOut(notice({ dedupeKey: "mail:a:1" }), first.deps)).deliver, true);
  const again = recorder(home, new Date(NOON.getTime() + 60_000));
  const dup = await reachOut(notice({ dedupeKey: "mail:a:1" }), again.deps);
  assert.equal(dup.reason, "duplicate");
  assert.equal(again.inapp.length + again.push.length, 0);
  const other = recorder(home, new Date(NOON.getTime() + 120_000));
  assert.equal((await reachOut(notice({ dedupeKey: "mail:a:2" }), other.deps)).deliver, true);
  const nextDay = recorder(home, new Date(NOON.getTime() + 25 * 3_600_000));
  assert.equal((await reachOut(notice({ dedupeKey: "mail:a:1" }), nextDay.deps)).deliver, true);
});

test("a dropped notice does not arm dedupe (turning the source back on lets it through)", async () => {
  const home = await homeWith((s) => {
    s.sources.mail = false;
  });
  const off = recorder(home, NOON);
  assert.equal((await reachOut(notice({ dedupeKey: "k" }), off.deps)).reason, "source-off");
  const s = utcSettings();
  await saveReachOutSettings(s, home);
  const on = recorder(home, new Date(NOON.getTime() + 1000));
  assert.equal((await reachOut(notice({ dedupeKey: "k" }), on.deps)).deliver, true);
});

test("red-line denial reaches no transport and is logged without the message", async () => {
  const home = await homeWith();
  const r = recorder(home, NOON);
  const out = await reachOut(
    notice({ title: "SECRET-TITLE", body: "SECRET-BODY", requestsDataConnection: true }),
    r.deps,
  );
  assert.equal(out.deliver, false);
  assert.equal(out.reason, "red-line:data-connection");
  assert.equal(r.inapp.length + r.push.length, 0);
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0]!, /red-line:data-connection/);
  assert.doesNotMatch(r.logs.join("\n"), /SECRET/);
  const entry = readLedger(home)[0]!;
  assert.equal(entry.type === "notice" && entry.outcome, "dropped");
});

test("Lisa-authored notes are screened for red lines even when the sender declares nothing", async () => {
  const home = await homeWith();
  const r = recorder(home, NOON);
  const ask = await reachOut(
    notice({ source: "idle", kind: "note", body: "I could do more if you connect your calendar." }),
    r.deps,
  );
  assert.equal(ask.reason, "red-line:data-connection");
  const guilt = await reachOut(
    notice({ source: "desire", kind: "note", body: "你都不理我了。" }),
    r.deps,
  );
  assert.equal(guilt.reason, "red-line:emotional-pressure");
  assert.equal(r.inapp.length + r.push.length, 0);
  // The same words quoted from someone's email are not Lisa's wording.
  const quoted = await reachOut(
    notice({ source: "mail", kind: "important", body: "Sam: please connect your calendar" }),
    r.deps,
  );
  assert.equal(quoted.deliver, true);
});

test("the ledger never contains a title or a body", async () => {
  const home = await homeWith();
  const r = recorder(home, NOON);
  const out = await reachOut(
    notice({
      title: "Quarterly numbers from Dana",
      body: "The acquisition closes Friday — keep it quiet.",
      dedupeKey: "acct-7:uid-4411",
      kind: "Important Mail!!",
    }),
    r.deps,
  );
  await recordReachOutFeedback(out.id, "useful", home, NOON);
  const raw = fs.readFileSync(reachOutLedgerPath(home), "utf8");
  for (const leak of [
    "Quarterly",
    "Dana",
    "acquisition",
    "Friday",
    "acct-7",
    "uid-4411",
    "Important Mail",
  ]) {
    assert.ok(!raw.includes(leak), `ledger leaked "${leak}"`);
  }
  const entry = readLedger(home)[0]!;
  assert.ok(entry.type === "notice");
  assert.equal(entry.titleLen, "Quarterly numbers from Dana".length);
  assert.equal(entry.bodyLen, "The acquisition closes Friday — keep it quiet.".length);
  assert.match(entry.titleHash, /^[0-9a-f]{16}$/);
  assert.equal(entry.kind, "important-mail");
  assert.deepEqual(Object.keys(entry).sort(), [
    "bodyLen",
    "budget",
    "channels",
    "day",
    "dedupe",
    "id",
    "kind",
    "outcome",
    "priority",
    "reason",
    "score",
    "solicited",
    "source",
    "titleHash",
    "titleLen",
    "ts",
    "type",
    "v",
  ]);
});

test("feedback feeds the value gate: a dismissed kind stops pushing, a useful mark restores it", async () => {
  const home = await homeWith((s) => {
    s.dial = "high";
  });
  const idle = (i: number) => notice({ source: "idle", kind: "note", title: `note ${i}` });
  const a = await reachOut(idle(1), recorder(home, NOON).deps);
  assert.deepEqual(a.channels, ["inapp", "push"]);
  await recordReachOutFeedback(a.id, "dismissed", home, NOON);
  const b = await reachOut(idle(2), recorder(home, NOON).deps);
  assert.deepEqual(b.channels, ["inapp"]);
  assert.equal(b.reason, "below-value-bar");
  // Another source+kind is unaffected.
  assert.deepEqual((await reachOut(notice(), recorder(home, NOON).deps)).channels, [
    "inapp",
    "push",
  ]);
  await recordReachOutFeedback(b.id, "useful", home, NOON);
  const c = await reachOut(idle(3), recorder(home, NOON).deps);
  assert.deepEqual(c.channels, ["inapp", "push"]);
  // Old dismissals are forgiven after the feedback window.
  await recordReachOutFeedback(c.id, "dismissed", home, NOON);
  const later = new Date(NOON.getTime() + 31 * 86_400_000);
  assert.deepEqual((await reachOut(idle(4), recorder(home, later).deps)).channels, [
    "inapp",
    "push",
  ]);
});

test("feedback for an unknown id is refused", async () => {
  const home = await homeWith();
  assert.deepEqual(await recordReachOutFeedback("ro_nope", "useful", home), {
    ok: false,
    error: "not_found",
  });
});

test("quiet hours: the push is held, then released when the window ends", async () => {
  const home = await homeWith();
  const r = recorder(home, NIGHT);
  const out = await reachOut(notice(), r.deps);
  assert.deepEqual(out.channels, ["inapp"]);
  assert.deepEqual(out.deferred, ["push"]);
  assert.equal(r.inapp.length, 1);
  assert.equal(r.push.length, 0);
  assert.equal(r.queue.size(), 1);

  // Still quiet at 07:59 — nothing is due.
  assert.equal(await r.queue.flushDue(new Date("2026-10-03T07:59:00Z")), 0);
  assert.equal(r.push.length, 0);
  assert.equal(await r.queue.flushDue(new Date("2026-10-03T08:00:00Z")), 1);
  assert.equal(r.push.length, 1);
  assert.equal(r.push[0]!.notice.id, out.id);
  assert.equal(r.queue.size(), 0);
  const release = readLedger(home).find((e) => e.type === "release");
  assert.deepEqual(release && release.type === "release" && release.channels, ["push"]);
});

test("a held push is not released if the user turned the dial off meanwhile", async () => {
  const home = await homeWith();
  const r = recorder(home, NIGHT);
  await reachOut(notice(), r.deps);
  await saveReachOutSettings(utcSettings({ dial: "off" }), home);
  assert.equal(await r.queue.flushDue(new Date("2026-10-03T08:00:00Z")), 1);
  assert.equal(r.push.length, 0);
});

test("a held push waits longer if quiet hours were extended", async () => {
  const home = await homeWith();
  const r = recorder(home, NIGHT);
  await reachOut(notice(), r.deps);
  const longer = utcSettings();
  longer.quietHours.end = "10:00";
  await saveReachOutSettings(longer, home);
  assert.equal(await r.queue.flushDue(new Date("2026-10-03T08:00:00Z")), 0);
  assert.equal(r.queue.size(), 1);
  assert.equal(await r.queue.flushDue(new Date("2026-10-03T10:00:00Z")), 1);
  assert.equal(r.push.length, 1);
});

test("an approval at night pushes immediately, silently", async () => {
  const home = await homeWith();
  const r = recorder(home, NIGHT);
  const out = await reachOut(
    notice({ source: "approval", kind: "tool", priority: "high" }),
    r.deps,
  );
  assert.deepEqual(out.channels, ["inapp", "push"]);
  assert.equal(r.push[0]!.silent, true);
  assert.equal(r.queue.size(), 0);
});

test("corrupt settings ⇒ the gate behaves as the charter's defaults", async () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(reachOutSettingsPath(home)), { recursive: true });
  fs.writeFileSync(reachOutSettingsPath(home), '{"dial":"high","sources":');
  // Local noon so the default (host-zone) quiet hours are not in play.
  const localNoon = new Date(2026, 9, 2, 12, 0, 0);
  const seen: ReachOutChannel[][] = [];
  for (let i = 0; i < 4; i++) {
    const r = recorder(home, localNoon);
    seen.push((await reachOut(notice({ title: `n${i}` }), r.deps)).channels);
  }
  // Default dial "normal" ⇒ budget 3, not the 8 the corrupt file asked for.
  assert.deepEqual(seen, [["inapp", "push"], ["inapp", "push"], ["inapp", "push"], ["inapp"]]);
});

test("a transport that throws does not break the sender or the other channels", async () => {
  const home = await homeWith();
  const r = recorder(home, NOON);
  r.deps.transports = {
    inapp: () => {
      throw new Error("sse down");
    },
    push: (n, o) => void r.push.push({ notice: n, silent: o.silent }),
  };
  const out = await reachOut(notice(), r.deps);
  assert.equal(out.deliver, true);
  assert.equal(r.push.length, 1);
  assert.ok(r.logs.some((l) => l.includes("inapp delivery failed")));
});

test("gate error (unwritable ledger): in-app only, approvals still push, red lines still hold", async () => {
  const dir = tmpHome();
  const home = path.join(dir, "not-a-dir");
  fs.writeFileSync(home, "this is a file, so <home>/reachout cannot be created");
  const r = recorder(home, NOON);
  const plain = await reachOut(notice(), r.deps);
  assert.equal(plain.reason, "gate-error");
  assert.deepEqual(plain.channels, ["inapp"]);
  const approval = await reachOut(notice({ source: "approval" }), r.deps);
  assert.deepEqual(approval.channels, ["inapp", "push"]);
  const red = await reachOut(notice({ requestsDataConnection: true }), r.deps);
  assert.deepEqual([red.deliver, red.reason], [false, "red-line:data-connection"]);
});

test("concurrent notices cannot overspend the budget", async () => {
  const home = await homeWith((s) => {
    s.quietHours.enabled = false;
  });
  const r = recorder(home, NOON);
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => reachOut(notice({ title: `c${i}` }), r.deps)),
  );
  assert.equal(results.filter((x) => x.channels.includes("push")).length, DAILY_BUDGET.normal);
  assert.equal(r.inapp.length, 10);
});

// ── tenants ────────────────────────────────────────────────────────────────

function withGlobalHome<T>(fn: (globalHome: string) => Promise<T>): Promise<T> {
  const prev = process.env.LISA_HOME;
  const globalHome = tmpHome();
  process.env.LISA_HOME = globalHome;
  return fn(globalHome).finally(() => {
    if (prev === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = prev;
  });
}

test("tenant isolation: uid A's settings and ledger do not affect uid B", async () => {
  await withGlobalHome(async () => {
    const off = utcSettings({ dial: "off" });
    await saveReachOutSettings(off, homeForUid("userA"));
    await saveReachOutSettings(utcSettings(), homeForUid("userB"));

    const mk = (uid: string | null): { r: Recorder; n: ReachOutNotice } => {
      const r = recorder("unused", NOON);
      delete r.deps.home; // resolve the home from the notice's uid
      return { r, n: notice({ uid, source: "task", kind: "routine" }) };
    };
    const a = mk("userA");
    const b = mk("userB");
    assert.deepEqual((await reachOut(a.n, a.r.deps)).channels, ["inapp"]); // A's dial is off
    assert.deepEqual((await reachOut(b.n, b.r.deps)).channels, ["inapp", "push"]);

    // B spends their whole unsolicited budget; A's ledger is untouched.
    await saveReachOutSettings(utcSettings(), homeForUid("userA"));
    for (let i = 0; i < 3; i++) {
      const x = mk("userB");
      await reachOut(notice({ uid: "userB", title: `b${i}` }), x.r.deps);
    }
    const overB = mk("userB");
    assert.deepEqual((await reachOut(notice({ uid: "userB" }), overB.r.deps)).channels, ["inapp"]);
    const freshA = mk("userA");
    assert.deepEqual((await reachOut(notice({ uid: "userA" }), freshA.r.deps)).channels, [
      "inapp",
      "push",
    ]);

    const ledgerA = readLedger(homeForUid("userA"));
    const ledgerB = readLedger(homeForUid("userB"));
    assert.equal(ledgerA.length, 2);
    assert.equal(ledgerB.length, 5);
    const ids = new Set(ledgerA.map((e) => e.id));
    assert.ok(ledgerB.every((e) => !ids.has(e.id)));
  });
});

test("inside one tenant's scope, a notice for another uid is refused and written nowhere", async () => {
  await withGlobalHome(async (globalHome) => {
    const r = recorder("unused", NOON);
    delete r.deps.home;
    const out = await homeScope.run(homeForUid("userA"), () =>
      reachOut(notice({ uid: "userB" }), r.deps),
    );
    assert.equal(out.reason, "tenant-mismatch");
    assert.equal(out.deliver, false);
    assert.equal(r.inapp.length + r.push.length, 0);
    assert.equal(fs.existsSync(path.join(globalHome, "users")), false);
    // An operator-level (uid null) notice inside a tenant scope is refused too.
    assert.equal(
      homeScope.run(homeForUid("userA"), () => homeForNotice(notice({ uid: null }))),
      null,
    );
    // A uid that tries to climb out of users/ is refused.
    assert.equal(homeForNotice(notice({ uid: "../../etc" })), null);
    assert.equal(homeForNotice(notice({ uid: "userA" })), homeForUid("userA"));
  });
});

test("sources are covered: every charter source has a decision path", () => {
  const seen = new Set<ReachOutSource>();
  for (const source of REACH_OUT_SOURCES) {
    const d = decideReachOut(notice({ source }), ctx());
    assert.ok(d.deliver, source);
    seen.add(source);
  }
  assert.equal(seen.size, 9);
});
