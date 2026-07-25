/**
 * Feed subscriptions + brief state — the config side of the daily brief.
 *
 * ~/.lisa/kb/feeds.json is USER-AUTHORED (there is deliberately no UI to
 * create it in v2.0): its existence is the consent. No feeds.json, or an
 * empty feeds list, means the entire capability is inert — no fetches, no
 * timers doing work, no model calls (decision D4: no new consent signal;
 * mirrors mail's "no account connected" gate).
 *
 *   {
 *     "feeds": [{ "id": "hn", "url": "https://hnrss.org/frontpage",
 *                 "tags": ["tech"], "max": 30, "weight": 1.5 }],
 *     "briefHour": 8,
 *     "budgetTokens": 120000,
 *     "sessdata": "…"        // optional, read by the bilibili adapter
 *   }
 *
 * The file may hold SESSDATA (a real login cookie), so it is chmod 0600 on
 * every load and listed in kb/.gitignore — the KB dir is a git repo and a
 * cookie must never land in its history.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, ensureDir, pathExists } from "../../fs-utils.js";
import { kbDir } from "../paths.js";

export interface KbFeed {
  id: string;
  /** Only "rss" today (D8: subscription discovery is RSSHub-compatible URLs). */
  kind?: string;
  url: string;
  tags?: string[];
  /** Per-sweep cap of new items taken from this feed (default 30). */
  max?: number;
  /** Ranking multiplier for this feed's items (watchlist weight, default 1). */
  weight?: number;
}

export interface FeedsConfig {
  feeds: KbFeed[];
  /** Local hour (0-23) after which the daily brief runs. */
  briefHour: number;
  /** Daily model-token ceiling for classification (0 = unlimited). */
  budgetTokens: number;
}

export const DEFAULT_BRIEF_HOUR = 8;
export const DEFAULT_BRIEF_BUDGET_TOKENS = 120_000;
/** How many top-ranked items get full-text ingested into sources/. */
export const DEFAULT_BRIEF_TOP_N = 3;

export function feedsFile(): string {
  return path.join(kbDir(), "feeds.json");
}
export function feedsDir(): string {
  return path.join(kbDir(), "feeds");
}
/** Machine state (seen ids, last brief date) — ours, not the user's. */
export function feedsStateFile(): string {
  return path.join(feedsDir(), ".state.json");
}
export function briefJsonFile(date: string): string {
  return path.join(feedsDir(), `${date}.json`);
}

/** kb/.gitignore must exclude feeds.json (SESSDATA) + feed machine state. */
async function ensureGitignore(): Promise<void> {
  const file = path.join(kbDir(), ".gitignore");
  const wanted = ["feeds.json", "feeds/"];
  let lines: string[] = [];
  if (await pathExists(file)) {
    lines = (await fs.readFile(file, "utf8")).split("\n").map((l) => l.trim());
  }
  const missing = wanted.filter((w) => !lines.includes(w));
  if (missing.length === 0) return;
  const next = [...lines.filter(Boolean), ...missing].join("\n") + "\n";
  await atomicWrite(file, next);
}

export async function loadFeedsConfig(): Promise<FeedsConfig> {
  const file = feedsFile();
  const empty: FeedsConfig = {
    feeds: [],
    briefHour: DEFAULT_BRIEF_HOUR,
    budgetTokens: DEFAULT_BRIEF_BUDGET_TOKENS,
  };
  if (!(await pathExists(file))) return empty;
  // Defensive tightening on every read: the user created the file by hand,
  // very possibly 0644, and it may hold a login cookie.
  await fs.chmod(file, 0o600).catch(() => {});
  await ensureGitignore().catch(() => {});
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error(`[kb-brief] ${file} is not valid JSON (${(err as Error).message}) — feeds disabled until fixed`);
    return empty;
  }
  const rawFeeds = Array.isArray(parsed.feeds) ? parsed.feeds : [];
  const feeds: KbFeed[] = [];
  for (const f of rawFeeds) {
    const feed = f as Partial<KbFeed>;
    if (typeof feed.url !== "string" || !feed.url) continue;
    feeds.push({
      id: typeof feed.id === "string" && feed.id ? feed.id : `feed-${feeds.length + 1}`,
      kind: typeof feed.kind === "string" ? feed.kind : "rss",
      url: feed.url,
      tags: Array.isArray(feed.tags) ? feed.tags.filter((t): t is string => typeof t === "string") : [],
      max: typeof feed.max === "number" && feed.max > 0 ? Math.floor(feed.max) : undefined,
      weight: typeof feed.weight === "number" && feed.weight > 0 ? feed.weight : undefined,
    });
  }
  const hour = Number(parsed.briefHour);
  const budget = Number(parsed.budgetTokens);
  return {
    feeds,
    briefHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_BRIEF_HOUR,
    budgetTokens: Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_BRIEF_BUDGET_TOKENS,
  };
}

// ── machine state ─────────────────────────────────────────────────────

const SEEN_CAP = 300;

export interface FeedsState {
  /** feed id → recently-seen item ids (newest last, capped). */
  seen: Record<string, string[]>;
  lastBriefDate: string | null;
}

export async function loadFeedsState(): Promise<FeedsState> {
  const file = feedsStateFile();
  if (!(await pathExists(file))) return { seen: {}, lastBriefDate: null };
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<FeedsState>;
    return {
      seen: parsed.seen && typeof parsed.seen === "object" ? (parsed.seen as Record<string, string[]>) : {},
      lastBriefDate: typeof parsed.lastBriefDate === "string" ? parsed.lastBriefDate : null,
    };
  } catch {
    return { seen: {}, lastBriefDate: null }; // state is rebuildable — worst case, one repeat brief
  }
}

export async function saveFeedsState(state: FeedsState): Promise<void> {
  await ensureDir(feedsDir());
  const capped: FeedsState = {
    seen: Object.fromEntries(
      Object.entries(state.seen).map(([k, ids]) => [k, ids.slice(-SEEN_CAP)]),
    ),
    lastBriefDate: state.lastBriefDate,
  };
  await atomicWrite(feedsStateFile(), JSON.stringify(capped, null, 2) + "\n");
}
