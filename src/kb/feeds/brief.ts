/**
 * The daily brief — pure logic (scheduling, personalized ranking, assembly,
 * formatting). Mirrors mail's isDigestDue/buildDigest/formatDigestText shapes;
 * the I/O lives in service.ts.
 *
 * Ranking is what distinguishes this from a generic RSS reader: items are
 * scored against the USER — watchlist (per-feed) weight × classifier
 * importance × term overlap with their wiki and their MEMORY.md/USER.md
 * interests — so the top of the brief is "what matters to you", not "what the
 * loudest feed pushed today".
 */
import { tokenize } from "../../tokenize.js";
import { localDate } from "../../mail/service.js";
import type { FeedItem } from "./rss.js";

export { localDate };

/** Same shape as mail's isDigestDue: pure, polled by the server timer. */
export function isBriefDue(lastBriefDate: string | null, now: Date, targetHour: number): boolean {
  if (lastBriefDate === localDate(now.getTime())) return false;
  return now.getHours() >= targetHour;
}

export const BRIEF_CATEGORIES = [
  "research",
  "engineering",
  "product",
  "release",
  "news",
  "opinion",
  "community",
  "other",
] as const;
export type BriefCategory = (typeof BRIEF_CATEGORIES)[number];
export type BriefImportance = 0 | 1 | 2 | 3;

export interface BriefItem {
  feedId: string;
  id: string;
  title: string;
  link?: string;
  published?: string;
  category: BriefCategory;
  importance: BriefImportance;
  /** Classifier's one-line takeaway (same language as the item). */
  oneLine: string;
  /** Personalized rank score — see scoreItem. */
  score: number;
}

export interface KbBrief {
  date: string;
  generatedAt: string;
  feedCount: number;
  total: number;
  items: BriefItem[];
  /** Slugs of the top items whose full text was ingested into sources/. */
  ingested: string[];
}

// ── personalization signals ───────────────────────────────────────────

export interface RankSignals {
  /** Tokenized MEMORY.md + USER.md — what the user says they care about. */
  interestTerms: Set<string>;
  /** Tokenized wiki page titles+tags — what they've already built knowledge on. */
  wikiTerms: Set<string>;
  /** feed id → watchlist weight (default 1). */
  feedWeight: Record<string, number>;
}

export function buildSignals(opts: {
  memoryText: string;
  wikiTitles: string[];
  feedWeight: Record<string, number>;
}): RankSignals {
  return {
    interestTerms: new Set(tokenize(opts.memoryText)),
    wikiTerms: new Set(tokenize(opts.wikiTitles.join("\n"))),
    feedWeight: opts.feedWeight,
  };
}

function overlap(tokens: string[], terms: Set<string>): number {
  if (terms.size === 0 || tokens.length === 0) return 0;
  let hits = 0;
  for (const t of new Set(tokens)) if (terms.has(t)) hits++;
  return hits;
}

/**
 * score = (1 + importance) × feedWeight × (1 + interest/wiki affinity).
 * Affinity saturates (log-ish via capped counts) so one keyword-stuffed item
 * can't run away with the brief.
 */
export function scoreItem(
  item: { feedId: string; title: string; summary?: string; importance: BriefImportance },
  signals: RankSignals,
): number {
  const tokens = tokenize(`${item.title}\n${item.summary ?? ""}`);
  const interest = Math.min(overlap(tokens, signals.interestTerms), 6);
  const wiki = Math.min(overlap(tokens, signals.wikiTerms), 6);
  const weight = signals.feedWeight[item.feedId] ?? 1;
  return (1 + item.importance) * weight * (1 + 0.25 * interest + 0.15 * wiki);
}

// ── assembly + formatting ─────────────────────────────────────────────

const BRIEF_ITEM_CAP = 30;

export function buildBrief(
  items: BriefItem[],
  opts: { date: string; feedCount: number; ingested?: string[]; now?: () => number },
): KbBrief {
  const sorted = [...items].sort((a, b) => b.score - a.score || (b.published ?? "").localeCompare(a.published ?? ""));
  return {
    date: opts.date,
    generatedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    feedCount: opts.feedCount,
    total: items.length,
    items: sorted.slice(0, BRIEF_ITEM_CAP),
    ingested: opts.ingested ?? [],
  };
}

/**
 * Markdown body for sources/brief-<date>.md (D7: the brief itself becomes a
 * Layer-1 entry so it is searchable, linkable, distillable) — also what the
 * CLI prints and (truncated) what lands in chat/push.
 */
export function formatBriefText(brief: KbBrief): string {
  if (brief.total === 0) return `📰 Brief ${brief.date}: no new items across ${brief.feedCount} feed(s).`;
  const lines: string[] = [`📰 Brief ${brief.date} — ${brief.total} new item(s) from ${brief.feedCount} feed(s)`, ""];
  const top = brief.items.slice(0, 10);
  for (const item of top) {
    const mark = item.importance >= 3 ? "‼" : item.importance === 2 ? "•" : "·";
    lines.push(`${mark} **${item.title}**${item.link ? ` — ${item.link}` : ""}`);
    if (item.oneLine && item.oneLine !== item.title) lines.push(`  ${item.oneLine}`);
  }
  if (brief.items.length > top.length) {
    lines.push("", `…and ${brief.items.length - top.length} more (kb/feeds/${brief.date}.json)`);
  }
  if (brief.ingested.length) {
    lines.push("", `Full text saved: ${brief.ingested.map((s) => `[[${s}]]`).join(" · ")}`);
  }
  return lines.join("\n");
}
