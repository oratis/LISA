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

/** Daily mail digest. `manual` = the user pressed "sweep now" — their own request. */
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
    solicited: input.manual,
    // One scheduled digest per day; a manual sweep is never a duplicate.
    ...(input.manual ? {} : { dedupeKey: `mail-digest:${input.date}` }),
  };
}

/** Important-mail alert (intraday poll). `tag` is the alert's account:uid. */
export function mailAlertNotice(alert: {
  title: string;
  body: string;
  tag: string;
}): ReachOutNotice {
  return {
    uid: null,
    source: "mail",
    kind: "important",
    title: alert.title,
    body: alert.body,
    priority: "high",
    actionable: true,
    dedupeKey: `mail:${alert.tag}`,
  };
}

/** Daily knowledge-base brief. `manual` = the user asked for it now. */
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
    solicited: input.manual,
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
