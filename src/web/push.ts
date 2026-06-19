/**
 * Operational push notifications — tell the phone when a dispatched/managed agent
 * finishes, errors, or blocks on a permission, or when Reve left a "while you were
 * away" note. OPT-IN and event-scoped — NOT proactive emotional outreach (that
 * stays a ROADMAP non-goal); this is closer to a CI notification.
 *
 * Transport is pluggable:
 *  - `ntfy` works today with zero Apple infra — a plain HTTP POST to a topic on
 *    ntfy.sh (or your self-hosted server); the topic name is the shared secret.
 *  - `apns` is the iOS-native path (token-based auth, HTTP/2). It's fully wired
 *    here but inert until you provide an Apple push key via env:
 *      LISA_APNS_KEY_ID, LISA_APNS_TEAM_ID, LISA_APNS_KEY (.p8 PEM or a path),
 *      LISA_APNS_TOPIC (default ai.meetlisa.pocket), LISA_APNS_ENV=production.
 *    Without those, apnsConfigFromEnv() returns null and delivery logs a stub.
 * Payloads carry low-sensitivity metadata only (agent / project / state / reason)
 * — never prompts, replies, full commands, or terminal output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http2 from "node:http2";
import type { AgentSession } from "../integrations/types.js";

export interface PushPrefs {
  done: boolean;
  error: boolean;
  permission: boolean;
  idle: boolean;
  advisor: boolean;
}
export function defaultPushPrefs(): PushPrefs {
  return { done: true, error: true, permission: true, idle: true, advisor: false };
}
export function normalizePushPrefs(p: Partial<PushPrefs> | null | undefined): PushPrefs {
  const base = defaultPushPrefs();
  if (!p || typeof p !== "object") return base;
  const pick = (k: keyof PushPrefs): boolean => (typeof p[k] === "boolean" ? (p[k] as boolean) : base[k]);
  return { done: pick("done"), error: pick("error"), permission: pick("permission"), idle: pick("idle"), advisor: pick("advisor") };
}

export interface PushSubscription {
  id: string;
  kind: "ntfy" | "apns";
  /** ntfy topic, or APNs device token. */
  target: string;
  /** ntfy server base (default https://ntfy.sh); ignored for apns. */
  server?: string;
  prefs: PushPrefs;
  createdAt: number;
}

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
function pushPath(): string {
  return path.join(lisaHome(), "push.json");
}

export function loadPush(): PushSubscription[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pushPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is PushSubscription =>
          !!s && typeof (s as PushSubscription).id === "string" && typeof (s as PushSubscription).target === "string",
      )
      .map((s) => ({ ...s, kind: s.kind === "apns" ? "apns" : "ntfy", prefs: normalizePushPrefs(s.prefs) }));
  } catch {
    return [];
  }
}
function savePush(list: PushSubscription[]): void {
  const file = pushPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

export function registerPush(
  input: { kind?: string; target: string; server?: string; prefs?: Partial<PushPrefs> },
  now: number = Date.now(),
): PushSubscription {
  const kind = input.kind === "apns" ? "apns" : "ntfy";
  const sub: PushSubscription = {
    id: crypto.randomBytes(6).toString("hex"),
    kind,
    target: input.target,
    ...(input.server ? { server: input.server } : {}),
    prefs: normalizePushPrefs(input.prefs),
    createdAt: now,
  };
  // Replace any existing subscription for the same (kind, target).
  const list = loadPush().filter((s) => !(s.kind === kind && s.target === input.target));
  list.push(sub);
  savePush(list);
  return sub;
}
export function unregisterPush(idOrTarget: string): boolean {
  const list = loadPush();
  const next = list.filter((s) => s.id !== idOrTarget && s.target !== idOrTarget);
  if (next.length === list.length) return false;
  savePush(next);
  return true;
}
export function listPush(): PushSubscription[] {
  return loadPush();
}
export function setPushPrefs(id: string, prefs: Partial<PushPrefs>): PushSubscription | null {
  const list = loadPush();
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  s.prefs = normalizePushPrefs({ ...s.prefs, ...prefs });
  savePush(list);
  return s;
}

// ── Live Activity push tokens (one per pinned session) ─────────────────────
export interface LiveActivityReg {
  sessionId: string;
  /** The ActivityKit push token (hex) for this session's Live Activity. */
  token: string;
  createdAt: number;
}
function liveActivitiesPath(): string {
  return path.join(lisaHome(), "live-activities.json");
}
export function listLiveActivities(): LiveActivityReg[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(liveActivitiesPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is LiveActivityReg =>
        !!r && typeof (r as LiveActivityReg).sessionId === "string" && typeof (r as LiveActivityReg).token === "string",
    );
  } catch {
    return [];
  }
}
export function registerLiveActivity(sessionId: string, token: string, now: number = Date.now()): void {
  const list = listLiveActivities().filter((r) => r.sessionId !== sessionId);
  list.push({ sessionId, token, createdAt: now });
  const file = liveActivitiesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}
export function unregisterLiveActivity(sessionId: string): boolean {
  const list = listLiveActivities();
  const next = list.filter((r) => r.sessionId !== sessionId);
  if (next.length === list.length) return false;
  fs.writeFileSync(liveActivitiesPath(), JSON.stringify(next, null, 2));
  return true;
}

// ── pure trigger ──────────────────────────────────────────────────────────
/** Custom URL scheme Lisa Pocket registers for push / widget deep-links. */
export const POCKET_SCHEME = "lisapocket";

/** Deep-link that opens Lisa Pocket at a specific roster session. Pure. The app
 *  routes on host="session" + the agent/id query (Lisa Pocket's URL handler). */
export function agentDeepLink(agent: string, sessionId: string): string {
  // URLSearchParams encodes spaces as "+", which iOS URLComponents reads literally
  // (not as a space); use %20 so values round-trip on the app side.
  const q = new URLSearchParams({ agent, id: sessionId }).toString().replace(/\+/g, "%20");
  return `${POCKET_SCHEME}://session?${q}`;
}

export interface PushEvent {
  pref: keyof PushPrefs;
  title: string;
  body: string;
  priority: "high" | "default";
  /** Throttle/dedup tag within a session. */
  tag: string;
  /** Optional deep-link opened when the notification is tapped (ntfy `Click`). */
  click?: string;
}

/** Which notifications a session's prev→next transition warrants. Pure. */
export function agentPushEvents(prev: AgentSession | undefined, next: AgentSession): PushEvent[] {
  const out: PushEvent[] = [];
  const who = `${next.agent} · ${next.project || next.agent}`;
  const click = agentDeepLink(next.agent, next.sessionId);
  if (next.state === "done" && prev?.state !== "done")
    out.push({ pref: "done", title: `${who} — done`, body: "Finished.", priority: "default", tag: "done", click });
  if (next.state === "error" && prev?.state !== "error")
    out.push({ pref: "error", title: `${who} — error`, body: next.stateReason || "errored", priority: "high", tag: "error", click });
  const pend = next.activity?.pendingPermission;
  if (pend && pend !== prev?.activity?.pendingPermission)
    out.push({ pref: "permission", title: `${who} — needs permission`, body: `waiting on: ${pend}`, priority: "high", tag: "permission", click });
  return out;
}

// ── ntfy transport (injectable fetch for tests) ───────────────────────────
type FetchLike = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<{ ok: boolean }>;

export async function sendNtfy(
  server: string,
  topic: string,
  ev: { title: string; body: string; priority: "high" | "default"; click?: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  try {
    const base = (server || "https://ntfy.sh").replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: ev.body,
      headers: {
        Title: ev.title,
        Priority: ev.priority === "high" ? "high" : "default",
        // ntfy opens this URL when the notification is tapped — a lisapocket://
        // deep-link routes into the app (see agentDeepLink).
        ...(ev.click ? { Click: ev.click } : {}),
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── APNs transport (token-based auth; needs an Apple key, else a no-op stub) ──
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 auth-key contents (PEM). */
  key: string;
  /** Bundle id, e.g. ai.meetlisa.pocket. */
  topic: string;
  /** api.push.apple.com (prod) or api.sandbox.push.apple.com (dev). */
  host: string;
}

/**
 * APNs config from env, or null (→ stub). LISA_APNS_KEY is the .p8 contents (PEM)
 * or a path to it; LISA_APNS_ENV=production switches to the prod host.
 */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const keyId = env.LISA_APNS_KEY_ID;
  const teamId = env.LISA_APNS_TEAM_ID;
  const raw = env.LISA_APNS_KEY;
  if (!keyId || !teamId || !raw) return null;
  let key = raw;
  if (!raw.includes("BEGIN")) {
    try { key = fs.readFileSync(raw, "utf8"); } catch { return null; }
  }
  const topic = env.LISA_APNS_TOPIC || "ai.meetlisa.pocket";
  const host = env.LISA_APNS_ENV === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  return { keyId, teamId, key, topic, host };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build a signed ES256 provider JWT for APNs. Pure given (cfg, nowSec). */
export function buildApnsJwt(cfg: Pick<ApnsConfig, "keyId" | "teamId" | "key">, nowSec: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: cfg.keyId })));
  const claims = b64url(Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: nowSec })));
  const signingInput = `${header}.${claims}`;
  const signer = crypto.createSign("SHA256");
  signer.update(signingInput);
  // ES256 JWTs use raw R||S (IEEE-P1363), not the DER that sign() defaults to.
  const sig = signer.sign({ key: crypto.createPrivateKey(cfg.key), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

/** Build the APNs JSON payload from a push event. Pure. */
export function buildApnsPayload(ev: { title: string; body: string; click?: string }): Record<string, unknown> {
  return {
    aps: { alert: { title: ev.title, body: ev.body }, sound: "default" },
    // Custom key the app reads on tap to deep-link (mirrors the ntfy Click URL).
    ...(ev.click ? { link: ev.click } : {}),
  };
}

export type ApnsPoster = (o: {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number }>;

/** Real APNs POST over HTTP/2. Settles exactly once and always closes the client;
 *  resolves status 0 on a connection error or a 10s timeout. */
const realApnsPost: ApnsPoster = (o) =>
  new Promise((resolve) => {
    const client = http2.connect(`https://${o.host}`);
    let status = 0;
    let settled = false;
    const done = (s: number) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch { /* already closing */ }
      resolve({ status: s });
    };
    client.on("error", () => done(0));
    const req = client.request({ ":method": "POST", ":path": o.path, ...o.headers });
    req.setEncoding("utf8");
    req.setTimeout(10_000, () => done(0)); // don't leak a hung connection
    req.on("response", (h) => { status = Number(h[":status"]) || 0; });
    req.on("data", () => {});
    req.on("end", () => done(status));
    req.on("error", () => done(0));
    req.end(o.body);
  });

// JWT cache keyed by config identity (not just time) — a different key/team must
// not reuse a stale token (wrong kid/iss → APNs 403).
let cachedApnsJwt: { token: string; at: number; id: string } | null = null;

/** Send one APNs notification. The provider JWT is cached ~50min (Apple rate-
 *  limits regeneration). `post` is injectable for tests. */
export async function sendApns(
  cfg: ApnsConfig,
  deviceToken: string,
  ev: { title: string; body: string; priority: "high" | "default"; click?: string },
  post: ApnsPoster = realApnsPost,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const cacheId = `${cfg.keyId}/${cfg.teamId}`;
  if (!cachedApnsJwt || cachedApnsJwt.id !== cacheId || nowSec - cachedApnsJwt.at > 50 * 60) {
    cachedApnsJwt = { token: buildApnsJwt(cfg, nowSec), at: nowSec, id: cacheId };
  }
  const res = await post({
    host: cfg.host,
    path: `/3/device/${deviceToken}`,
    headers: {
      authorization: `bearer ${cachedApnsJwt.token}`,
      "apns-topic": cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": ev.priority === "high" ? "10" : "5",
      // Operational alerts are time-sensitive — don't let APNs store & deliver
      // a stale one later if the device is offline.
      "apns-expiration": ev.priority === "high" ? "0" : String(nowSec + 3600),
    },
    body: JSON.stringify(buildApnsPayload(ev)),
  });
  return res.status === 200;
}

// ── Live Activity remote updates (ActivityKit over APNs) ───────────────────
export interface LiveActivityState {
  state: string;
  detail: string;
  turns: number;
}

/** Content-state for a session's Live Activity — mirrors the app's
 *  AgentActivityAttributes.ContentState + its detail() logic. Pure. */
export function liveActivityState(s: AgentSession): LiveActivityState {
  const a = s.activity;
  const last = a?.lastTools && a.lastTools.length ? a.lastTools[a.lastTools.length - 1] : undefined;
  const detail = a?.pendingPermission ? `⚠ ${a.pendingPermission}` : (s.stateReason || last || s.state);
  return { state: s.state, detail, turns: a?.turnCount ?? 0 };
}

/** APNs Live Activity payload — `event:"update"` refreshes, `"end"` dismisses. Pure. */
export function buildLiveActivityPayload(
  cs: LiveActivityState,
  event: "update" | "end",
  nowSec: number,
): Record<string, unknown> {
  return {
    aps: {
      timestamp: nowSec,
      event,
      "content-state": { state: cs.state, detail: cs.detail, turns: cs.turns },
      ...(event === "end" ? { "dismissal-date": nowSec } : {}),
    },
  };
}

/** Push a Live Activity update/end over APNs (push-type liveactivity). `post`
 *  injectable for tests. Reuses the cached provider JWT. */
export async function sendLiveActivityUpdate(
  cfg: ApnsConfig,
  laToken: string,
  cs: LiveActivityState,
  event: "update" | "end",
  post: ApnsPoster = realApnsPost,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const cacheId = `${cfg.keyId}/${cfg.teamId}`;
  if (!cachedApnsJwt || cachedApnsJwt.id !== cacheId || nowSec - cachedApnsJwt.at > 50 * 60) {
    cachedApnsJwt = { token: buildApnsJwt(cfg, nowSec), at: nowSec, id: cacheId };
  }
  const res = await post({
    host: cfg.host,
    path: `/3/device/${laToken}`,
    headers: {
      authorization: `bearer ${cachedApnsJwt.token}`,
      "apns-topic": `${cfg.topic}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
    },
    body: JSON.stringify(buildLiveActivityPayload(cs, event, nowSec)),
  });
  return res.status === 200;
}

// ── bridge: hub/idle events → throttled per-subscription delivery ──────────
export interface PushBridgeOpts {
  subs?: () => PushSubscription[];
  /** Injected delivery (tests). Default: real ntfy / apns-stub. */
  deliver?: (sub: PushSubscription, ev: PushEvent) => void | Promise<void>;
  /** Registered Live Activity tokens (tests). Default: the on-disk store. */
  liveActivities?: () => LiveActivityReg[];
  /** Injected Live Activity delivery (tests). Default: real APNs liveactivity. */
  liveDeliver?: (token: string, cs: LiveActivityState, event: "update" | "end") => void | Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  throttleMs?: number;
}

export class PushBridge {
  private readonly prev = new Map<string, AgentSession>();
  private readonly lastSent = new Map<string, number>();
  private readonly subs: () => PushSubscription[];
  private readonly deliverFn: (sub: PushSubscription, ev: PushEvent) => void | Promise<void>;
  private readonly liveActivities: () => LiveActivityReg[];
  private readonly liveDeliverFn: (token: string, cs: LiveActivityState, event: "update" | "end") => void | Promise<void>;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly throttleMs: number;
  private readonly liveThrottleMs = 3000;

  constructor(opts: PushBridgeOpts = {}) {
    this.subs = opts.subs ?? listPush;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.throttleMs = opts.throttleMs ?? 30_000;
    this.deliverFn = opts.deliver ?? ((sub, ev) => this.defaultDeliver(sub, ev));
    this.liveActivities = opts.liveActivities ?? listLiveActivities;
    this.liveDeliverFn = opts.liveDeliver ?? ((token, cs, event) => this.defaultLiveDeliver(token, cs, event));
  }

  onAgentUpdate(next: AgentSession): void {
    const key = `${next.agent}/${next.sessionId}`;
    const events = agentPushEvents(this.prev.get(key), next);
    this.prev.set(key, next);
    for (const ev of events) this.fire(ev, `${key}#${ev.tag}`);
    this.updateLiveActivity(next);
  }

  /** Refresh a pinned session's Live Activity (throttled), ending it on a
   *  terminal state. No-op unless an LA token is registered for the session. */
  private updateLiveActivity(next: AgentSession): void {
    const reg = this.liveActivities().find((r) => r.sessionId === next.sessionId);
    if (!reg) return;
    const terminal = next.state === "done" || next.state === "error";
    const key = `la#${next.sessionId}`;
    // Throttle progress refreshes, but always let a terminal "end" through.
    if (!terminal && this.now() - (this.lastSent.get(key) ?? -Infinity) < this.liveThrottleMs) return;
    this.lastSent.set(key, this.now());
    void Promise.resolve(this.liveDeliverFn(reg.token, liveActivityState(next), terminal ? "end" : "update")).catch(() => {});
    if (terminal) unregisterLiveActivity(next.sessionId);
  }

  onIdleMessage(text: string): void {
    this.fire(
      { pref: "idle", title: "Lisa — while you were away", body: text.slice(0, 200), priority: "default", tag: "idle" },
      `idle#${this.now()}`,
    );
  }

  private fire(ev: PushEvent, throttleKey: string): void {
    const subs = this.subs().filter((s) => s.prefs[ev.pref]);
    if (subs.length === 0) return;
    // -Infinity default ⇒ the FIRST event for a key is never throttled (even when now() is small).
    if (this.now() - (this.lastSent.get(throttleKey) ?? -Infinity) < this.throttleMs) return;
    this.lastSent.set(throttleKey, this.now());
    for (const sub of subs) void Promise.resolve(this.deliverFn(sub, ev)).catch(() => {});
  }

  private async defaultDeliver(sub: PushSubscription, ev: PushEvent): Promise<void> {
    if (sub.kind === "ntfy") {
      const ok = await sendNtfy(sub.server ?? "https://ntfy.sh", sub.target, ev);
      if (!ok) this.log(`[push] ntfy send failed for ${sub.id}`);
    } else {
      const cfg = apnsConfigFromEnv();
      if (!cfg) {
        this.log(`[push] apns not configured (set LISA_APNS_KEY/_KEY_ID/_TEAM_ID) — would notify ${sub.id}: ${ev.title}`);
        return;
      }
      const ok = await sendApns(cfg, sub.target, ev);
      if (!ok) this.log(`[push] apns send failed for ${sub.id}`);
    }
  }

  private async defaultLiveDeliver(token: string, cs: LiveActivityState, event: "update" | "end"): Promise<void> {
    const cfg = apnsConfigFromEnv();
    if (!cfg) {
      this.log(`[push] live-activity ${event} skipped (no APNs key)`);
      return;
    }
    const ok = await sendLiveActivityUpdate(cfg, token, cs, event);
    if (!ok) this.log(`[push] live-activity ${event} failed`);
  }
}
