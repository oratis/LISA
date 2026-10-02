import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PushEvent } from "../web/push.js";
import { TenantEventBus } from "../web/event-bus.js";
import { DeferQueue } from "./defer.js";
import {
  PUSH_PREF_FOR,
  attributedTitle,
  createReachOutTransports,
  hasReachOutImHook,
  inAppTextFor,
  pushEventFor,
  setReachOutImHook,
} from "./deliver.js";
import { reachOut } from "./gate.js";
import { defaultReachOutSettings, saveReachOutSettings } from "./settings.js";
import { REACH_OUT_SOURCES, type ReachOutNotice, type StampedNotice } from "./types.js";

afterEach(() => setReachOutImHook(null));

const stamped = (patch: Partial<StampedNotice> = {}): StampedNotice => ({
  uid: null,
  source: "task",
  kind: "routine",
  title: "Weekly report is ready",
  body: "12 pages, 3 charts.",
  priority: "normal",
  id: "ro_1",
  from: "Lisa",
  ai: true,
  at: "2026-10-02T12:00:00.000Z",
  ...patch,
});

test("every source maps to an existing push preference", () => {
  for (const s of REACH_OUT_SOURCES) assert.equal(typeof PUSH_PREF_FOR[s], "string", s);
  assert.equal(PUSH_PREF_FOR.approval, "permission");
  assert.equal(PUSH_PREF_FOR.mail, "mail");
  assert.equal(PUSH_PREF_FOR.brief, "brief");
});

test("every generic push says it is from Lisa", () => {
  assert.equal(attributedTitle("Weekly report is ready"), "Lisa — Weekly report is ready");
  assert.equal(attributedTitle("Lisa — while you were away"), "Lisa — while you were away");
  assert.equal(attributedTitle("  "), "Lisa");
  assert.equal(pushEventFor(stamped(), { silent: false }).title, "Lisa — Weekly report is ready");
});

test("pushEventFor: priority, body cap, tag and the silent flag", () => {
  const ev = pushEventFor(stamped({ priority: "critical", body: "x".repeat(500) }), {
    silent: true,
  });
  assert.equal(ev.priority, "high");
  assert.equal(ev.body.length, 240);
  assert.equal(ev.tag, "task:routine");
  assert.equal(ev.silent, true);
  assert.equal(ev.pref, "done");
  assert.equal("silent" in pushEventFor(stamped(), { silent: false }), false);
  assert.equal(pushEventFor(stamped({ priority: "low" }), { silent: false }).priority, "default");
});

test("inAppTextFor joins title and body, tolerating either being empty", () => {
  assert.equal(inAppTextFor(stamped()), "Weekly report is ready\n12 pages, 3 charts.");
  assert.equal(inAppTextFor(stamped({ title: "" })), "12 pages, 3 charts.");
  assert.equal(inAppTextFor(stamped({ body: " " })), "Weekly report is ready");
});

test("in-app transport emits to the notice's own tenant and remembers the note", async () => {
  const emitted: Array<{ event: Record<string, unknown>; uid: string | null }> = [];
  const remembered: Array<{ text: string; uid: string | null }> = [];
  const t = createReachOutTransports({
    inapp: {
      emit: (event, uid) => void emitted.push({ event, uid }),
      remember: (note, uid) => void remembered.push({ text: note.text, uid }),
    },
  });
  await t.inapp(stamped({ uid: "userA" }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.uid, "userA");
  assert.deepEqual(emitted[0]!.event, {
    type: "idle_message",
    text: "Weekly report is ready\n12 pages, 3 charts.",
    at: "2026-10-02T12:00:00.000Z",
    source: "task",
    kind: "routine",
    from: "Lisa",
    reachOutId: "ro_1",
  });
  assert.deepEqual(remembered, [
    { text: "Weekly report is ready\n12 pages, 3 charts.", uid: "userA" },
  ]);
});

test("through the real tenant bus, tenant A's notice never reaches tenant B or the operator", async () => {
  const bus = new TenantEventBus<{ write(chunk: string): unknown }>();
  const got: Record<string, string[]> = { a: [], b: [], operator: [] };
  bus.add({ write: (c) => got.a!.push(c) }, "userA");
  bus.add({ write: (c) => got.b!.push(c) }, "userB");
  bus.add({ write: (c) => got.operator!.push(c) }, null);
  const t = createReachOutTransports({
    inapp: { emit: (event, uid) => bus.broadcast(event, uid) },
  });
  await t.inapp(stamped({ uid: "userA", body: "A's private result" }));
  assert.equal(got.a!.length, 1);
  assert.match(got.a![0]!, /A's private result/);
  assert.equal(got.b!.length, 0);
  assert.equal(got.operator!.length, 0);
});

test("push transport: the machine-level push never carries a tenant's notice", () => {
  const sent: Array<{ ev: PushEvent; key: string }> = [];
  const t = createReachOutTransports({
    push: { notify: (ev, key) => void sent.push({ ev, key }) },
  });
  void t.push(stamped({ uid: "userA" }), { silent: false });
  assert.equal(sent.length, 0);
  void t.push(stamped(), { silent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.ev.silent, true);
  assert.equal(sent[0]!.key, "reachout#ro_1");
});

test("IM hook: a no-op until wired, then called with the stamped notice", async () => {
  const t = createReachOutTransports({});
  assert.equal(hasReachOutImHook(), false);
  await t.im(stamped()); // must not throw
  const seen: StampedNotice[] = [];
  setReachOutImHook((n) => void seen.push(n));
  assert.equal(hasReachOutImHook(), true);
  await t.im(stamped());
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.from, "Lisa");
});

test("end to end with the generic transports: a task result goes in-app + push, attributed", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-deliver-"));
  const s = defaultReachOutSettings();
  s.quietHours.tz = "UTC";
  await saveReachOutSettings(s, home);
  const emitted: Array<Record<string, unknown>> = [];
  const pushed: PushEvent[] = [];
  const notice: ReachOutNotice = {
    uid: null,
    source: "task",
    kind: "routine",
    title: "Weekly report is ready",
    body: "12 pages.",
    priority: "normal",
  };
  const out = await reachOut(notice, {
    home,
    now: () => new Date("2026-10-02T12:00:00Z"),
    proactiveMode: () => true,
    deferQueue: new DeferQueue({ tickMs: 0 }),
    available: { im: hasReachOutImHook() },
    transports: createReachOutTransports({
      inapp: { emit: (event) => void emitted.push(event) },
      push: { notify: (ev) => void pushed.push(ev) },
    }),
  });
  assert.deepEqual(out.channels, ["inapp", "push"]);
  assert.equal(out.reason, "solicited");
  assert.equal(emitted[0]!.reachOutId, out.id);
  assert.equal(emitted[0]!.from, "Lisa");
  assert.equal(pushed[0]!.title, "Lisa — Weekly report is ready");
});
