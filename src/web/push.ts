/**
 * Operational push notifications — tell the phone when a dispatched/managed agent
 * finishes, errors, or blocks on a permission, or when Reve left a "while you were
 * away" note. OPT-IN and event-scoped — NOT proactive emotional outreach (that
 * stays a ROADMAP non-goal); this is closer to a CI notification.
 *
 * Transport is pluggable:
 *  - `ntfy` works today with zero Apple infra — a plain HTTP POST to a topic on
 *    ntfy.sh (or your self-hosted server); the topic name is the shared secret.
 *  - `apns` is the iOS-native path and needs an Apple push key, so it's a
 *    documented stub here (logs "would notify").
 * Payloads carry low-sensitivity metadata only (agent / project / state / reason)
 * — never prompts, replies, full commands, or terminal output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

// ── pure trigger ──────────────────────────────────────────────────────────
/** Custom URL scheme Lisa Pocket registers for push / widget deep-links. */
export const POCKET_SCHEME = "lisapocket";

/** Deep-link that opens Lisa Pocket at a specific roster session. Pure. The app
 *  routes on host="session" + the agent/id query (Lisa Pocket's URL handler). */
export function agentDeepLink(agent: string, sessionId: string): string {
  const q = new URLSearchParams({ agent, id: sessionId });
  return `${POCKET_SCHEME}://session?${q.toString()}`;
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

// ── bridge: hub/idle events → throttled per-subscription delivery ──────────
export interface PushBridgeOpts {
  subs?: () => PushSubscription[];
  /** Injected delivery (tests). Default: real ntfy / apns-stub. */
  deliver?: (sub: PushSubscription, ev: PushEvent) => void | Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
  throttleMs?: number;
}

export class PushBridge {
  private readonly prev = new Map<string, AgentSession>();
  private readonly lastSent = new Map<string, number>();
  private readonly subs: () => PushSubscription[];
  private readonly deliverFn: (sub: PushSubscription, ev: PushEvent) => void | Promise<void>;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly throttleMs: number;

  constructor(opts: PushBridgeOpts = {}) {
    this.subs = opts.subs ?? listPush;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.throttleMs = opts.throttleMs ?? 30_000;
    this.deliverFn = opts.deliver ?? ((sub, ev) => this.defaultDeliver(sub, ev));
  }

  onAgentUpdate(next: AgentSession): void {
    const key = `${next.agent}/${next.sessionId}`;
    const events = agentPushEvents(this.prev.get(key), next);
    this.prev.set(key, next);
    for (const ev of events) this.fire(ev, `${key}#${ev.tag}`);
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
      this.log(`[push] apns not wired (needs an Apple push key) — would notify ${sub.id}: ${ev.title}`);
    }
  }
}
