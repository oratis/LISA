/**
 * Daily digest builder — pure. Turns classified MailItems into a DailyDigest:
 * counts, per-category buckets, the "needs you" list, and a templated summary.
 * (The service may replace `summary` with a model-written narrative.)
 */
import {
  MAIL_CATEGORIES,
  type DailyDigest,
  type DigestBucket,
  type MailCategory,
  type MailItem,
} from "./types.js";

const BUCKET_SAMPLE = 3;
const NEEDS_YOU_CAP = 12;

/** importance desc, then newest first. */
function byImportanceThenDate(a: MailItem, b: MailItem): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  return b.date - a.date;
}

export interface BuildDigestOpts {
  date: string;
  accountIds: string[];
  /** Count of unread among the swept set; defaults to total. */
  unread?: number;
  now?: () => number;
}

export function buildDigest(items: MailItem[], opts: BuildDigestOpts): DailyDigest {
  const now = opts.now ?? Date.now;
  const sorted = [...items].sort(byImportanceThenDate);

  const needsYou = sorted.filter((i) => i.importance >= 2).slice(0, NEEDS_YOU_CAP);

  const buckets: DigestBucket[] = [];
  for (const category of MAIL_CATEGORIES) {
    const inCat = sorted.filter((i) => i.category === category);
    if (inCat.length === 0) continue;
    buckets.push({ category, count: inCat.length, items: inCat.slice(0, BUCKET_SAMPLE) });
  }
  // Most-populous buckets first, but always surface action-y categories near the top.
  const priority: Record<string, number> = { urgent: 0, security: 1, personal: 2, finance: 3, calendar: 4, work: 5 };
  buckets.sort((a, b) => {
    const pa = priority[a.category] ?? 9;
    const pb = priority[b.category] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.count - a.count;
  });

  return {
    date: opts.date,
    generatedAt: now(),
    accountIds: [...opts.accountIds],
    total: items.length,
    unread: opts.unread ?? items.length,
    needsYou,
    buckets,
    summary: templateSummary(items.length, needsYou, buckets),
  };
}

/** Deterministic one-paragraph summary. Pure. */
export function templateSummary(total: number, needsYou: MailItem[], buckets: DigestBucket[]): string {
  if (total === 0) return "No new mail.";
  const parts: string[] = [`${total} new email${total === 1 ? "" : "s"}.`];
  if (needsYou.length > 0) {
    const top = needsYou
      .slice(0, 3)
      .map((i) => `“${i.subject.slice(0, 48)}” (${shortFrom(i.from)})`)
      .join("; ");
    parts.push(`${needsYou.length} need${needsYou.length === 1 ? "s" : ""} you: ${top}.`);
  } else {
    parts.push("Nothing needs your attention.");
  }
  const breakdown = buckets
    .filter((b) => !["urgent", "personal"].includes(b.category) || b.count > 0)
    .slice(0, 6)
    .map((b) => `${b.category} ${b.count}`)
    .join(" · ");
  if (breakdown) parts.push(`Breakdown: ${breakdown}.`);
  return parts.join(" ");
}

function shortFrom(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m?.[1] ?? from).trim().slice(0, 32);
}

/** Format a digest as a compact plain-text message (push body / chat / CLI). Pure. */
export function formatDigestText(d: DailyDigest): string {
  const lines: string[] = [`📬 Mail digest · ${d.date}`, d.summary];
  if (d.needsYou.length) {
    lines.push("", "Needs you:");
    for (const i of d.needsYou.slice(0, 5)) {
      lines.push(`  • [${i.importance === 3 ? "‼" : "!"}] ${i.subject.slice(0, 60)} — ${shortFrom(i.from)}`);
    }
  }
  return lines.join("\n");
}

/** A category is "actionable" if items in it usually want the user. */
export function isActionableCategory(c: MailCategory): boolean {
  return c === "urgent" || c === "personal" || c === "calendar" || c === "finance" || c === "work";
}
