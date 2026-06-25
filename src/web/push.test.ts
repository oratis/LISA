import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentSession } from "../integrations/types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-push-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "push.json");

const {
  defaultPushPrefs,
  normalizePushPrefs,
  agentPushEvents,
  agentDeepLink,
  sendNtfy,
  apnsConfigFromEnv,
  buildApnsJwt,
  buildApnsPayload,
  sendApns,
  liveActivityState,
  buildLiveActivityPayload,
  sendLiveActivityUpdate,
  registerLiveActivity,
  unregisterLiveActivity,
  listLiveActivities,
  PushBridge,
  registerPush,
  unregisterPush,
  listPush,
  setPushPrefs,
} = await import("./push.js");

beforeEach(() => fs.rmSync(FILE, { force: true }));

const sess = (o: Partial<AgentSession>): AgentSession => ({
  agent: "claude-code",
  sessionId: "s1",
  project: "proj",
  state: "working",
  stateReason: "",
  lastMtime: 0,
  ...o,
});
const withPending = (p: string) =>
  sess({ activity: { turnCount: 1, lastTools: [], filesTouched: [], pendingPermission: p } });

describe("push prefs", () => {
  test("defaults: done/error/permission/idle/mail on, advisor off", () => {
    assert.deepEqual(defaultPushPrefs(), { done: true, error: true, permission: true, idle: true, advisor: false, mail: true });
  });
  test("normalize coerces non-bool / missing / null to defaults", () => {
    assert.deepEqual(normalizePushPrefs({ advisor: true }), { ...defaultPushPrefs(), advisor: true });
    assert.deepEqual(normalizePushPrefs({ done: "no" as unknown as boolean }), defaultPushPrefs());
    assert.deepEqual(normalizePushPrefs(null), defaultPushPrefs());
  });
});

describe("agentPushEvents (pure trigger)", () => {
  test("working→done fires done", () => {
    assert.deepEqual(agentPushEvents(sess({ state: "working" }), sess({ state: "done" })).map((e) => e.pref), ["done"]);
  });
  test("working→error fires error (high) with the reason", () => {
    const [e] = agentPushEvents(sess({ state: "working" }), sess({ state: "error", stateReason: "build failed" }));
    assert.equal(e.pref, "error");
    assert.equal(e.priority, "high");
    assert.match(e.body, /build failed/);
  });
  test("pendingPermission appearing fires permission", () => {
    const [e] = agentPushEvents(sess({}), withPending("Bash"));
    assert.equal(e.pref, "permission");
    assert.match(e.body, /Bash/);
  });
  test("no transition / unchanged pending → nothing", () => {
    assert.deepEqual(agentPushEvents(sess({ state: "working" }), sess({ state: "working" })), []);
    assert.deepEqual(agentPushEvents(withPending("Bash"), withPending("Bash")), []);
  });
  test("first sight already done (prev undefined) → fires", () => {
    assert.equal(agentPushEvents(undefined, sess({ state: "done" }))[0]!.pref, "done");
  });
  test("events carry a lisapocket:// deep-link to the session", () => {
    const [e] = agentPushEvents(sess({ state: "working" }), sess({ state: "done", agent: "codex", sessionId: "s9" }));
    assert.equal(e!.click, agentDeepLink("codex", "s9"));
    const u = new URL(e!.click!);
    assert.equal(u.protocol, "lisapocket:");
    assert.equal(u.host, "session");
    assert.equal(u.searchParams.get("agent"), "codex");
    assert.equal(u.searchParams.get("id"), "s9");
  });
  test("agentDeepLink encodes spaces as %20 (not +) so iOS round-trips them", () => {
    const link = agentDeepLink("claude code", "s 9");
    assert.ok(!link.includes("+"), "no + encoding");
    assert.match(link, /%20/);
    const u = new URL(link);
    assert.equal(u.searchParams.get("agent"), "claude code");
    assert.equal(u.searchParams.get("id"), "s 9");
  });
});

describe("sendNtfy", () => {
  test("POSTs body + Title/Priority headers to <server>/<topic>", async () => {
    let captured: { url: string; init: { body: string; headers: Record<string, string> } } | null = null;
    const ok = await sendNtfy(
      "https://ntfy.sh/",
      "my-topic",
      { title: "T", body: "B", priority: "high" },
      async (url, init) => {
        captured = { url, init };
        return { ok: true };
      },
    );
    assert.equal(ok, true);
    assert.equal(captured!.url, "https://ntfy.sh/my-topic");
    assert.equal(captured!.init.body, "B");
    assert.equal(captured!.init.headers.Title, "T");
    assert.equal(captured!.init.headers.Priority, "high");
    assert.equal(captured!.init.headers.Click, undefined); // omitted when no click
  });
  test("sets the Click header when the event has a deep-link", async () => {
    let headers: Record<string, string> = {};
    await sendNtfy(
      "https://ntfy.sh",
      "t",
      { title: "T", body: "B", priority: "default", click: "lisapocket://session?agent=codex&id=s9" },
      async (_url, init) => {
        headers = init.headers;
        return { ok: true };
      },
    );
    assert.equal(headers.Click, "lisapocket://session?agent=codex&id=s9");
  });
  test("network throw → false", async () => {
    const ok = await sendNtfy("https://x", "t", { title: "a", body: "b", priority: "default" }, async () => {
      throw new Error("net");
    });
    assert.equal(ok, false);
  });
});

describe("PushBridge", () => {
  test("delivers to subs whose pref is on; skips pref-off subs", () => {
    const delivered: Array<{ id: string; tag: string }> = [];
    const subs = [
      { id: "a", kind: "ntfy" as const, target: "ta", prefs: defaultPushPrefs(), createdAt: 0 },
      { id: "b", kind: "ntfy" as const, target: "tb", prefs: { ...defaultPushPrefs(), done: false }, createdAt: 0 },
    ];
    const bridge = new PushBridge({ subs: () => subs, now: () => 1000, deliver: (s, ev) => void delivered.push({ id: s.id, tag: ev.tag }) });
    bridge.onAgentUpdate(sess({ state: "working" }));
    bridge.onAgentUpdate(sess({ state: "done" }));
    assert.deepEqual(delivered, [{ id: "a", tag: "done" }]); // only "a" (b has done:false)
  });

  test("throttles a repeat of the same tag within the window", () => {
    const delivered: string[] = [];
    const subs = [{ id: "a", kind: "ntfy" as const, target: "t", prefs: defaultPushPrefs(), createdAt: 0 }];
    let t = 0;
    const bridge = new PushBridge({ subs: () => subs, now: () => t, throttleMs: 1000, deliver: (_s, ev) => void delivered.push(ev.tag) });
    bridge.onAgentUpdate(withPending("Bash")); // fires permission @0
    t = 100;
    bridge.onAgentUpdate(withPending("Write")); // new pending → event, but throttled (<1000)
    t = 2000;
    bridge.onAgentUpdate(withPending("Edit")); // throttle elapsed → fires
    assert.deepEqual(delivered, ["permission", "permission"]);
  });
});

describe("push storage", () => {
  test("register → list; same target replaces; unregister; setPrefs", () => {
    const a = registerPush({ kind: "ntfy", target: "topic-1", prefs: { advisor: true } }, 1);
    assert.equal(listPush().length, 1);
    assert.equal(listPush()[0]!.prefs.advisor, true);
    registerPush({ kind: "ntfy", target: "topic-1" }, 2); // same target → replace
    assert.equal(listPush().length, 1);
    const updated = setPushPrefs(listPush()[0]!.id, { error: false });
    assert.equal(updated!.prefs.error, false);
    assert.equal(unregisterPush(a.target), true);
    assert.equal(listPush().length, 0);
    assert.equal(unregisterPush("nope"), false);
  });
});

describe("APNs", () => {
  // Throwaway P-256 key so we can sign + verify without a real Apple key.
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  test("apnsConfigFromEnv: null without env; populated + host by env", () => {
    assert.equal(apnsConfigFromEnv({} as NodeJS.ProcessEnv), null);
    const cfg = apnsConfigFromEnv({
      LISA_APNS_KEY_ID: "K1", LISA_APNS_TEAM_ID: "T1", LISA_APNS_KEY: pem, LISA_APNS_ENV: "production",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(cfg?.keyId, "K1");
    assert.equal(cfg?.topic, "ai.meetlisa.pocket");
    assert.equal(cfg?.host, "api.push.apple.com");
  });

  test("buildApnsJwt: ES256 header/claims + a verifiable signature", () => {
    const jwt = buildApnsJwt({ keyId: "K1", teamId: "T1", key: pem }, 1000);
    const [h, c, s] = jwt.split(".");
    assert.equal(JSON.parse(Buffer.from(h!, "base64url").toString()).alg, "ES256");
    assert.equal(JSON.parse(Buffer.from(h!, "base64url").toString()).kid, "K1");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    assert.equal(claims.iss, "T1");
    assert.equal(claims.iat, 1000);
    const verifier = crypto.createVerify("SHA256");
    verifier.update(`${h}.${c}`);
    assert.equal(verifier.verify({ key: kp.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")), true);
  });

  test("buildApnsPayload: aps.alert + optional deep-link", () => {
    const p = buildApnsPayload({ title: "T", body: "B", click: "lisapocket://session?id=s" });
    assert.deepEqual((p.aps as { alert: unknown }).alert, { title: "T", body: "B" });
    assert.equal(p.link, "lisapocket://session?id=s");
    assert.equal(buildApnsPayload({ title: "T", body: "B" }).link, undefined);
  });

  test("sendApns: POSTs /3/device/<token> with apns headers; 200→true, 4xx→false", async () => {
    const cfg = { keyId: "K1", teamId: "T1", key: pem, topic: "ai.meetlisa.pocket", host: "api.sandbox.push.apple.com" };
    let captured: { host: string; path: string; headers: Record<string, string>; body: string } | null = null;
    const ok = await sendApns(
      cfg, "devtoken", { title: "T", body: "B", priority: "high", click: "lisapocket://x" },
      async (o) => { captured = o; return { status: 200 }; }, 1000,
    );
    assert.equal(ok, true);
    assert.equal(captured!.path, "/3/device/devtoken");
    assert.equal(captured!.headers["apns-topic"], "ai.meetlisa.pocket");
    assert.equal(captured!.headers["apns-push-type"], "alert");
    assert.equal(captured!.headers["apns-priority"], "10");
    assert.equal(captured!.headers["apns-expiration"], "0"); // high-priority → deliver-now-or-drop
    assert.match(captured!.headers.authorization, /^bearer /);

    const bad = await sendApns(cfg, "devtoken", { title: "T", body: "B", priority: "default" },
      async () => ({ status: 400 }), 1000);
    assert.equal(bad, false);
  });
});

describe("Live Activity remote updates", () => {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const cfg = { keyId: "K1", teamId: "T1", key: pem, topic: "ai.meetlisa.pocket", host: "api.sandbox.push.apple.com" };

  test("liveActivityState mirrors the app's content-state + detail()", () => {
    assert.deepEqual(
      liveActivityState(withPending("Bash")),
      { state: "working", detail: "⚠ Bash", turns: 1 },
    );
    assert.deepEqual(
      liveActivityState(sess({ state: "error", stateReason: "boom" })),
      { state: "error", detail: "boom", turns: 0 },
    );
  });

  test("buildLiveActivityPayload: aps event + content-state; end adds dismissal-date", () => {
    const up = buildLiveActivityPayload({ state: "working", detail: "x", turns: 3 }, "update", 1000);
    const aps = up.aps as Record<string, unknown>;
    assert.equal(aps.event, "update");
    assert.equal(aps.timestamp, 1000);
    assert.deepEqual(aps["content-state"], { state: "working", detail: "x", turns: 3 });
    assert.equal(aps["dismissal-date"], undefined);
    const end = buildLiveActivityPayload({ state: "done", detail: "x", turns: 3 }, "end", 1000);
    assert.equal((end.aps as Record<string, unknown>)["dismissal-date"], 1000);
  });

  test("sendLiveActivityUpdate: liveactivity push-type + topic suffix", async () => {
    let captured: { path: string; headers: Record<string, string>; body: string } | null = null;
    const ok = await sendLiveActivityUpdate(
      cfg, "latoken", { state: "working", detail: "x", turns: 1 }, "update",
      async (o) => { captured = o; return { status: 200 }; }, 1000,
    );
    assert.equal(ok, true);
    assert.equal(captured!.path, "/3/device/latoken");
    assert.equal(captured!.headers["apns-topic"], "ai.meetlisa.pocket.push-type.liveactivity");
    assert.equal(captured!.headers["apns-push-type"], "liveactivity");
  });

  test("store: register replaces per session; unregister removes", () => {
    registerLiveActivity("sess-A", "tok1", 1);
    registerLiveActivity("sess-A", "tok2", 2); // same session → replace
    const a = listLiveActivities().filter((r) => r.sessionId === "sess-A");
    assert.equal(a.length, 1);
    assert.equal(a[0]!.token, "tok2");
    assert.equal(unregisterLiveActivity("sess-A"), true);
    assert.equal(listLiveActivities().some((r) => r.sessionId === "sess-A"), false);
  });

  test("PushBridge pushes an LA update for a registered session; ends + clears on done", () => {
    const events: Array<{ token: string; event: string; state: string }> = [];
    const regs = [{ sessionId: "s1", token: "tokX", createdAt: 0 }];
    const bridge = new PushBridge({
      subs: () => [],
      liveActivities: () => regs.filter((r) => regs.includes(r)),
      now: () => 100000,
      liveDeliver: (token, cs, event) => void events.push({ token, event, state: cs.state }),
    });
    bridge.onAgentUpdate(sess({ state: "working" }));        // → update
    bridge.onAgentUpdate(sess({ state: "done" }));           // → end (terminal, not throttled)
    assert.deepEqual(events, [
      { token: "tokX", event: "update", state: "working" },
      { token: "tokX", event: "end", state: "done" },
    ]);
  });
});
