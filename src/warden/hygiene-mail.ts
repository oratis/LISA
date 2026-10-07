/**
 * Inbound hygiene for mail — the adapter between `stripSensitiveTokens` and the
 * mail module's shapes (RawMail, MailItem, DailyDigest).
 *
 * The mail pipeline calls `sanitizeMailBatch` once, right where messages leave
 * the connector (src/mail/service.ts). Everything downstream of that point —
 * the classification prompt, the persisted digest, push alerts, the proactive
 * chat message, `/api/mail/digest` — only ever holds cleaned text. The same
 * function is applied again at the two places text is handed to a model or to
 * the chat (classify.ts, alerts.ts) and when an older digest is read back from
 * disk (store.ts); the filter is idempotent, so the repeats cost a few
 * microseconds and close the door on a future caller that skips the service.
 */
import type { DailyDigest, MailItem } from "../mail/types.js";
import {
  addHygieneCounts,
  emptyHygieneCounts,
  hygieneTotal,
  stripSensitiveTokens,
  type HygieneCounts,
} from "./hygiene.js";

/** The text-bearing fields of a mail record that this module cleans. */
export interface MailTextFields {
  from?: string;
  subject: string;
  snippet: string;
  /** Model-written one-liner on a classified item. */
  reason?: string;
}

/**
 * Joins subject and snippet for one pass. A code is often announced in one
 * field and printed in the other ("Your verification code" / "482913 …"), so
 * they have to be read together. The blank line makes the join count as one
 * sentence break; the private-use marker is where the result is split again.
 */
const FIELD_MARK = String.fromCharCode(0xe002);
const FIELD_JOIN = `\n\n${FIELD_MARK}`;

function dropMark(text: string): string {
  return text.includes(FIELD_MARK) ? text.split(FIELD_MARK).join("") : text;
}

/** Clean one mail record. Returns a copy; the input is not modified. */
export function sanitizeMailFields<T extends MailTextFields>(
  mail: T,
): { mail: T; removed: HygieneCounts } {
  let removed: HygieneCounts;
  // Edited through the base shape; every other field of T is carried over as is.
  const next: MailTextFields = { ...mail };

  const subject = dropMark(String(mail.subject ?? ""));
  const snippet = dropMark(String(mail.snippet ?? ""));
  // The snippet is a fixed-length cut of the body: a link running into its end
  // may have lost its token to the cut.
  const joint = stripSensitiveTokens(subject + FIELD_JOIN + snippet, { truncated: true });
  const cut = joint.text.indexOf(FIELD_JOIN);
  if (cut >= 0) {
    next.subject = joint.text.slice(0, cut);
    next.snippet = joint.text.slice(cut + FIELD_JOIN.length);
    removed = joint.removed;
  } else {
    // Cannot happen (the join is never part of a match), but never guess at a
    // split: fall back to cleaning each field on its own.
    const s = stripSensitiveTokens(subject);
    const b = stripSensitiveTokens(snippet, { truncated: true });
    next.subject = s.text;
    next.snippet = b.text;
    removed = addHygieneCounts(s.removed, b.removed);
  }

  for (const field of ["from", "reason"] as const) {
    const value = mail[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const cleaned = stripSensitiveTokens(value);
    next[field] = cleaned.text;
    removed = addHygieneCounts(removed, cleaned.removed);
  }
  return { mail: next as T, removed };
}

export interface MailBatchHygiene<T> {
  mails: T[];
  /** Totals across the batch. */
  removed: HygieneCounts;
  /** How many messages had at least one thing removed. */
  touched: number;
}

/** Clean a batch of mail records and total what was removed. */
export function sanitizeMailBatch<T extends MailTextFields>(mails: T[]): MailBatchHygiene<T> {
  let removed = emptyHygieneCounts();
  let touched = 0;
  const out = mails.map((m) => {
    const cleaned = sanitizeMailFields(m);
    if (hygieneTotal(cleaned.removed) > 0) touched++;
    removed = addHygieneCounts(removed, cleaned.removed);
    return cleaned.mail;
  });
  return { mails: out, removed, touched };
}

/**
 * Clean a digest read back from disk. Digests written before hygiene existed
 * hold raw subjects and snippets; this keeps them from reaching the chat or the
 * client unfiltered. A digest written by the current pipeline passes through
 * unchanged.
 */
export function sanitizeDigest(digest: DailyDigest): DailyDigest {
  const clean = (items: MailItem[]): MailItem[] =>
    Array.isArray(items) ? sanitizeMailBatch(items).mails : items;
  return {
    ...digest,
    summary:
      typeof digest.summary === "string"
        ? stripSensitiveTokens(digest.summary).text
        : digest.summary,
    needsYou: clean(digest.needsYou),
    buckets: Array.isArray(digest.buckets)
      ? digest.buckets.map((b) => ({ ...b, items: clean(b.items) }))
      : digest.buckets,
  };
}

/**
 * One log line for a batch — counts only, never a value, a subject or an
 * address. `null` when nothing was removed (nothing worth a line).
 */
export function hygieneLogLine(
  scope: string,
  batch: Pick<MailBatchHygiene<unknown>, "removed" | "touched">,
  total: number,
): string | null {
  if (hygieneTotal(batch.removed) === 0) return null;
  const { otp, signInLinks, resetLinks } = batch.removed;
  return (
    `[mail] hygiene ${scope}: cleaned ${batch.touched}/${total} message(s) — ` +
    `otp=${otp} signInLinks=${signInLinks} resetLinks=${resetLinks}`
  );
}
