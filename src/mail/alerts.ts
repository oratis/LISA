/**
 * Important-mail alerting — pure decision + formatting. The server's intraday
 * poll feeds freshly-classified items here; what survives becomes a high-priority
 * push + a proactive chat message.
 */
import type { MailItem } from "./types.js";

export const DEFAULT_ALERT_LEVEL = 3;
export const DEFAULT_POLL_MINUTES = 30;
/** Cap alerts per poll so a burst of important mail can't spam the user. */
export const MAX_ALERTS_PER_POLL = 3;

/** Importance threshold for a proactive alert (2 or 3); LISA_MAIL_ALERT_LEVEL. */
export function alertLevel(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LISA_MAIL_ALERT_LEVEL);
  return n === 2 || n === 3 ? n : DEFAULT_ALERT_LEVEL;
}

/** Minutes between intraday important-mail polls; 0 disables. LISA_MAIL_POLL_MINUTES. */
export function pollMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LISA_MAIL_POLL_MINUTES;
  if (raw === undefined) return DEFAULT_POLL_MINUTES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_POLL_MINUTES;
}

/** Items at/above the threshold, most-important + newest first. Pure. */
export function pickImportant(items: MailItem[], threshold: number): MailItem[] {
  return items
    .filter((i) => i.importance >= threshold)
    .sort((a, b) => b.importance - a.importance || b.date - a.date);
}

function who(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m?.[1] ?? from).trim().slice(0, 40);
}

export interface MailAlert {
  /** Push title. */
  title: string;
  /** Push body. */
  body: string;
  /** Dedup tag (account:uid). */
  tag: string;
  /** Proactive chat message text. */
  chat: string;
}

/** Format one important item into a push + chat alert. Pure. */
export function formatAlert(i: MailItem): MailAlert {
  const sender = who(i.from);
  const subject = i.subject.slice(0, 100) || "(no subject)";
  return {
    title: i.importance >= 3 ? "📬 Important mail" : "📬 Mail",
    body: `${sender}: ${subject.slice(0, 80)}`,
    tag: `${i.accountId}:${i.uid}`,
    chat:
      `📬 ${i.importance >= 3 ? "Important" : "Notable"} mail from ${sender}: ` +
      `“${subject}”${i.reason ? ` — ${i.reason}` : ""}`,
  };
}
