/**
 * The proactive senders that existed before the gate, described as notices.
 *
 * Each builder states what the sender is saying — source, kind, priority,
 * whether the user asked for it — and nothing about how it is delivered. The
 * server pairs the notice with the sender's original push / in-app closures,
 * so under default settings the content and cadence are exactly what they
 * were; only the decision to deliver moved into `reachOut()`.
 *
 * All of these are operator-level background jobs (uid null).
 */
import type { ReachOutNotice } from "./types.js";

/**
 * Daily mail digest. Solicited either way: the scheduled digest is something
 * the user switched on (mail consent + a connected account), and a manual
 * sweep is the user pressing "sweep now". So: no value gate, no budget — but
 * the source switch, dial "off" and quiet hours still apply.
 */
export function mailDigestNotice(input: {
  text: string;
  date: string;
  needsYou: number;
  manual: boolean;
}): ReachOutNotice {
  return {
    uid: null,
    source: "mail",
    kind: "digest",
    title: "📬 Mail digest",
    body: input.text,
    priority: "normal",
    actionable: input.needsYou > 0,
    solicited: true,
    // One scheduled digest per day; a manual sweep is never a duplicate.
    ...(input.manual ? {} : { dedupeKey: `mail-digest:${input.date}` }),
  };
}

/**
 * Important-mail alert (intraday poll). `tag` is the alert's account:uid.
 * Unsolicited and budgeted — but every alert from one poll carries that poll's
 * `budgetKey`, so a burst of three costs one unit of the daily budget, not three.
 */
export function mailAlertNotice(
  alert: { title: string; body: string; tag: string },
  pollKey: string,
): ReachOutNotice {
  return {
    uid: null,
    source: "mail",
    kind: "important",
    title: alert.title,
    body: alert.body,
    priority: "high",
    actionable: true,
    dedupeKey: `mail:${alert.tag}`,
    budgetKey: `mail-poll:${pollKey}`,
  };
}

/**
 * Daily knowledge-base brief. Solicited either way, like the mail digest: the
 * user set the feeds and the schedule up. `manual` = they asked for it now.
 */
export function kbBriefNotice(input: {
  text: string;
  date: string;
  manual: boolean;
}): ReachOutNotice {
  return {
    uid: null,
    source: "brief",
    kind: "daily",
    title: "📰 Daily brief",
    body: input.text,
    priority: "normal",
    solicited: true,
    ...(input.manual ? {} : { dedupeKey: `kb-brief:${input.date}` }),
  };
}

/**
 * Advisor digest. The advisor engine has already applied its own relevance
 * bar, 3h throttle and 24h dedup before anything reaches here, so no
 * `dedupeKey` — the gate adds the dial, quiet hours and the shared budget.
 */
export function advisorNotice(input: {
  text: string;
  suggestions: ReadonlyArray<{ urgency: "info" | "notice" | "urgent"; action?: unknown }>;
}): ReachOutNotice {
  return {
    uid: null,
    source: "advisor",
    kind: "digest",
    title: "Lisa — while you were away",
    body: input.text,
    priority: input.suggestions.some((s) => s.urgency === "urgent") ? "high" : "normal",
    actionable: input.suggestions.some((s) => Boolean(s.action)),
  };
}

/** The idle "[while you were away]" note. */
export function idleNoteNotice(text: string): ReachOutNotice {
  return {
    uid: null,
    source: "idle",
    kind: "note",
    title: "Lisa — while you were away",
    body: text,
    priority: "normal",
  };
}

/**
 * An unattended run (a task, routine or watcher) is waiting on an approval.
 * Source `approval`: the gate always delivers it (in-app, plus push where the
 * user has one), silently in quiet hours.
 *
 * The body says which task and which tool, and until when — never the
 * payload. The payload is shown only by the approval card itself, to a caller
 * who may approve, and a push goes through a third-party service.
 */
export function taskApprovalNotice(input: {
  uid: string | null;
  /** Inbox item id: one notice per approval. */
  approvalId: string;
  kind: "task" | "routine" | "watcher";
  title: string;
  tool: string;
  /** ISO instant the approval expires (and is then a deny). */
  expiresAt: string;
  now: number;
}): ReachOutNotice {
  const minutes = Math.max(1, Math.round((Date.parse(input.expiresAt) - input.now) / 60_000));
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
  return {
    uid: input.uid,
    source: "approval",
    kind: input.kind,
    title: "Approval needed",
    body:
      `Your ${input.kind} "${title}" wants to use ${input.tool}. Review it in Lisa's approvals ` +
      `within ${minutes} minute${minutes === 1 ? "" : "s"}; if nobody answers, it is not run.`,
    priority: "high",
    actionable: true,
    dedupeKey: `approval:${input.approvalId}`,
  };
}
