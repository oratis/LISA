/**
 * Reach-out — the one gate every proactive message passes through.
 *
 * The rules live in docs/POLICY_REACH_OUT.md (the charter). This module is the
 * mechanism: a sender describes what it wants to say as a `ReachOutNotice`, and
 * `reachOut()` (gate.ts) decides whether and on which channels it is delivered.
 * A sender that pushes or posts without going through the gate is a defect.
 */

export const REACH_OUT_SOURCES = [
  "task",
  "watcher",
  "approval",
  "mail",
  "brief",
  "advisor",
  "idle",
  "desire",
  "system",
] as const;
export type ReachOutSource = (typeof REACH_OUT_SOURCES)[number];

export const REACH_OUT_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type ReachOutPriority = (typeof REACH_OUT_PRIORITIES)[number];

export const REACH_OUT_CHANNELS = ["inapp", "push", "im"] as const;
export type ReachOutChannel = (typeof REACH_OUT_CHANNELS)[number];

export const REACH_OUT_DIALS = ["off", "low", "normal", "high"] as const;
export type ReachOutDial = (typeof REACH_OUT_DIALS)[number];

/** What a sender hands to the gate. */
export interface ReachOutNotice {
  /** Owning account in the cloud edition; null for the local/operator home. */
  uid: string | null;
  source: ReachOutSource;
  /** Sender-defined category within the source (e.g. "digest", "important"). */
  kind: string;
  title: string;
  body: string;
  priority: ReachOutPriority;
  /** Same key within the dedupe window ⇒ the later notice is dropped. */
  dedupeKey?: string;
  /** The user can act on it (feeds the value gate, like an advisor action). */
  actionable?: boolean;
  /**
   * The user explicitly asked for this result (their own task, routine or
   * watcher). Defaults to true for `task` / `watcher`, false otherwise.
   */
  solicited?: boolean;
  /** Red line: the message aims at getting the user to connect more accounts/data. */
  requestsDataConnection?: boolean;
  /** Red line: the wording applies emotional pressure, guilt or dependency. */
  emotionalPressure?: boolean;
}

/** Why the gate decided what it decided. Stable strings — they land in the ledger. */
export type ReachOutReason =
  | "ok"
  | "always-deliver"
  | "solicited"
  | "red-line:data-connection"
  | "red-line:emotional-pressure"
  | "empty"
  | "tenant-mismatch"
  | "gate-error"
  | "source-off"
  | "duplicate"
  | "dial-off"
  | "desire-in-app-only"
  | "below-value-bar"
  | "over-budget"
  | "quiet-hours"
  | "no-channel";

export interface ReachOutDecision {
  /** True when at least one channel delivers now. */
  deliver: boolean;
  /** Channels that deliver now. */
  channels: ReachOutChannel[];
  reason: ReachOutReason;
  /** ISO instant the deferred channels are released (end of quiet hours). */
  deferUntil?: string;
  /** Channels held until `deferUntil`. */
  deferred?: ReachOutChannel[];
  /** Quiet hours: deliver the push without sound if the transport can. */
  silent?: boolean;
  /** This notice consumed one unit of today's unsolicited budget. */
  countsBudget?: boolean;
  /** Value-gate score (unsolicited notices only). */
  score?: number;
}

/** What `reachOut()` returns: the decision plus the ledger id for feedback. */
export interface ReachOutResult extends ReachOutDecision {
  /** Ledger entry id — pass it to POST /api/reachout/feedback. */
  id: string;
}

/** A notice the gate let through. Every one is stamped as coming from Lisa. */
export interface StampedNotice extends ReachOutNotice {
  id: string;
  /** AI attribution — always "Lisa"; the gate adds it, senders cannot remove it. */
  from: "Lisa";
  ai: true;
  /** ISO instant of the decision. */
  at: string;
}

export interface ReachOutTransports {
  /** In-app: SSE to the owning tenant plus the persisted "latest note". */
  inapp: (notice: StampedNotice) => void | Promise<void>;
  /** Push to the user's subscribed devices. `silent` ⇒ no sound if supported. */
  push: (notice: StampedNotice, opts: { silent: boolean }) => void | Promise<void>;
  /** IM channel hook (no-op until the channels workstream wires it). */
  im: (notice: StampedNotice) => void | Promise<void>;
}

export type ReachOutVerdict = "useful" | "dismissed";
