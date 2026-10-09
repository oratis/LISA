/**
 * Reach-out transports — where a notice the gate let through actually goes.
 *
 *  - in-app: an SSE event to the owning tenant (and only that tenant), plus
 *    the persisted "latest note" the island shows on a fresh open — the same
 *    path the `idle_message` note has always used.
 *  - push: the machine-level PushBridge (ntfy / APNs). It belongs to whoever
 *    owns the machine, so a notice that carries a uid never reaches it.
 *  - im: a hook the channels workstream wires later; a no-op until then.
 *
 * The existing senders (mail, brief, advisor, idle) pass their own closures so
 * their wording and events stay byte-for-byte what they were; these generic
 * transports are for new callers (tasks, watchers, approvals).
 */
import type { PushEvent, PushPrefs } from "../web/push.js";
import type { ReachOutSource, ReachOutTransports, StampedNotice } from "./types.js";

/** Which existing per-subscription push preference governs each source. */
export const PUSH_PREF_FOR: Readonly<Record<ReachOutSource, keyof PushPrefs>> = Object.freeze({
  task: "done",
  watcher: "done",
  approval: "permission",
  mail: "mail",
  brief: "brief",
  // Advisor digests have always gone out under the "idle" preference.
  advisor: "idle",
  idle: "idle",
  desire: "idle",
  system: "error",
});

/** Every proactive message says it is from Lisa (charter §1.5). */
export function attributedTitle(title: string): string {
  const t = title.trim();
  if (!t) return "Lisa";
  return /\blisa\b/i.test(t) ? t : `Lisa — ${t}`;
}

/** The push a generic notice becomes — its `push` text when it has one. Pure. */
export function pushEventFor(notice: StampedNotice, opts: { silent: boolean }): PushEvent {
  const text = notice.push ?? notice;
  return {
    pref: PUSH_PREF_FOR[notice.source],
    title: attributedTitle(text.title),
    body: text.body.slice(0, 240),
    priority: notice.priority === "high" || notice.priority === "critical" ? "high" : "default",
    tag: `${notice.source}:${notice.kind}`,
    ...(opts.silent ? { silent: true } : {}),
  };
}

/** The in-app text of a generic notice. Pure. */
export function inAppTextFor(notice: StampedNotice): string {
  const title = notice.title.trim();
  const body = notice.body.trim();
  return title && body ? `${title}\n${body}` : title || body;
}

export interface InAppSink {
  /** Send an SSE event to the subscribers of exactly this tenant (null = local/operator). */
  emit: (event: Record<string, unknown>, uid: string | null) => void;
  /** Keep it as that tenant's latest unread note. */
  remember?: (note: { text: string; at: string }, uid: string | null) => void | Promise<void>;
}

export interface PushSink {
  notify: (event: PushEvent, throttleKey: string) => void;
}

export type ImHook = (notice: StampedNotice) => void | Promise<void>;

let imHook: ImHook | null = null;

/** Wire (or clear) the IM channel. Called by the channels workstream. */
export function setReachOutImHook(hook: ImHook | null): void {
  imHook = hook;
}

/** Is an IM channel wired? Until one is, the gate treats `im` as unavailable. */
export function hasReachOutImHook(): boolean {
  return imHook !== null;
}

export function createReachOutTransports(opts: {
  inapp?: InAppSink;
  push?: PushSink;
}): ReachOutTransports {
  return {
    inapp: async (notice) => {
      if (!opts.inapp) return;
      const text = inAppTextFor(notice);
      await opts.inapp.remember?.({ text, at: notice.at }, notice.uid);
      opts.inapp.emit(
        {
          type: "idle_message",
          text,
          at: notice.at,
          source: notice.source,
          kind: notice.kind,
          from: notice.from,
          reachOutId: notice.id,
        },
        notice.uid,
      );
    },
    push: (notice, { silent }) => {
      // Machine-level push is the operator's. Never route a tenant's notice to it.
      if (notice.uid !== null || !opts.push) return;
      opts.push.notify(pushEventFor(notice, { silent }), `reachout#${notice.id}`);
    },
    im: async (notice) => {
      if (imHook) await imHook(notice);
    },
  };
}
