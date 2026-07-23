/**
 * The daily-brief service: incremental feed sweep → classify → personalized
 * rank → top-N full-text ingest → write the brief twice → hand text back for
 * delivery. The server owns timers and delivery (mirroring mail); everything
 * here is callable directly (CLI, tests).
 *
 * Inert-by-default: no feeds configured ⇒ every entry point returns null
 * without touching the network, the model, or the disk beyond one config read
 * (decision D4).
 */
import fs from "node:fs/promises";
import { atomicWrite, ensureDir } from "../../fs-utils.js";
import { fetchFollowingSafeRedirects } from "../../tools/web_fetch.js";
import { readMemory } from "../../memory/store.js";
import { listEntries, addSource } from "../store.js";
import { ingestUrl } from "../ingest/index.js";
import { parseFeed, type FeedItem } from "./rss.js";
import { classifyFeedItems, type FeedClassifyOpts } from "./classify.js";
import {
  buildBrief,
  buildSignals,
  formatBriefText,
  isBriefDue,
  localDate,
  scoreItem,
  type BriefItem,
  type KbBrief,
} from "./brief.js";
import {
  briefJsonFile,
  feedsDir,
  loadFeedsConfig,
  loadFeedsState,
  saveFeedsState,
  DEFAULT_BRIEF_TOP_N,
  type FeedsConfig,
} from "./store.js";

export interface BriefRunOpts {
  /** Skip the once-per-day / target-hour gate (manual runs). */
  force?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  /** Test seams. */
  fetchImpl?: (url: string) => Promise<Response>;
  runModel?: FeedClassifyOpts["runModel"];
  ingest?: (url: string) => Promise<string | null>;
}

export interface BriefRunResult {
  brief: KbBrief;
  /** Rendered markdown (chat / push / CLI). */
  text: string;
}

const FEED_DEFAULT_MAX = 30;
const FETCH_CAP_BYTES = 2_000_000;

/** New items for one feed, oldest first so seen-state grows chronologically. */
export function pickNewItems(items: FeedItem[], seen: string[], max: number): FeedItem[] {
  const seenSet = new Set(seen);
  return items.filter((i) => !seenSet.has(i.id)).slice(0, max);
}

/**
 * Run the daily brief once. Returns null when inert (no feeds), not due, or
 * a sweep produced nothing new (state still advances so the day is marked).
 */
export async function runDailyBrief(opts: BriefRunOpts = {}): Promise<BriefRunResult | null> {
  const now = opts.now ?? Date.now;
  const config = await loadFeedsConfig();
  if (config.feeds.length === 0) return null; // fully lazy — D4

  const state = await loadFeedsState();
  const today = localDate(now());
  if (!opts.force && !isBriefDue(state.lastBriefDate, new Date(now()), config.briefHour)) {
    return null;
  }

  const fetchImpl =
    opts.fetchImpl ?? ((u: string) => fetchFollowingSafeRedirects(u, opts.signal));

  // ── sweep (per-feed failures degrade to "no items from that feed") ──
  const fresh: { feedId: string; item: FeedItem }[] = [];
  let feedsOk = 0;
  for (const feed of config.feeds) {
    try {
      const res = await fetchImpl(feed.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = (await res.text()).slice(0, FETCH_CAP_BYTES);
      const parsed = parseFeed(xml);
      const picked = pickNewItems(parsed.items, state.seen[feed.id] ?? [], feed.max ?? FEED_DEFAULT_MAX);
      for (const item of picked) fresh.push({ feedId: feed.id, item });
      state.seen[feed.id] = [...(state.seen[feed.id] ?? []), ...picked.map((i) => i.id)];
      feedsOk++;
    } catch (err) {
      console.error(`[kb-brief] feed ${feed.id} failed: ${(err as Error).message}`);
    }
  }

  // Every feed unreachable (network down, likely transient) → don't burn the
  // day; the next timer tick retries. A successful-but-empty sweep DOES mark
  // the day done.
  if (feedsOk === 0) {
    await saveFeedsState(state);
    return null;
  }
  state.lastBriefDate = today;
  await saveFeedsState(state);
  if (fresh.length === 0) return null;

  // ── classify under the daily budget (over-budget → default grading + log) ──
  const classified = await classifyFeedItems(
    fresh.map((f) => f.item),
    {
      budgetTokens: config.budgetTokens || undefined,
      signal: opts.signal,
      runModel: opts.runModel,
    },
  );
  const gradeById = new Map(classified.items.map((c) => [c.id, c]));

  // ── personalized ranking ──
  const [userMem, agentMem] = await Promise.all([readMemory("user"), readMemory("memory")]);
  const wiki = await listEntries("wiki");
  const signals = buildSignals({
    memoryText: `${userMem}\n${agentMem}`,
    wikiTitles: wiki.map((w) => `${w.title} ${w.tags.join(" ")}`),
    feedWeight: Object.fromEntries(config.feeds.map((f) => [f.id, f.weight ?? 1])),
  });

  const briefItems: BriefItem[] = fresh.map(({ feedId, item }) => {
    const grade = gradeById.get(item.id)!;
    return {
      feedId,
      id: item.id,
      title: item.title,
      link: item.link,
      published: item.published,
      category: grade.category,
      importance: grade.importance,
      oneLine: grade.oneLine,
      score: scoreItem(
        { feedId, title: item.title, summary: item.summary, importance: grade.importance },
        signals,
      ),
    };
  });

  // ── top-N full-text ingest (feeds are the user's own watchlist — D3) ──
  const ingest =
    opts.ingest ??
    (async (url: string): Promise<string | null> => {
      try {
        const res = await ingestUrl(url, { signal: opts.signal });
        return res.entry.slug;
      } catch (err) {
        console.error(`[kb-brief] full-text ingest failed for ${url}: ${(err as Error).message}`);
        return null;
      }
    });
  const ranked = [...briefItems].sort((a, b) => b.score - a.score);
  const ingested: string[] = [];
  for (const item of ranked) {
    if (ingested.length >= DEFAULT_BRIEF_TOP_N) break;
    if (!item.link) continue;
    const slug = await ingest(item.link);
    if (slug) ingested.push(slug);
  }

  const brief = buildBrief(briefItems, {
    date: today,
    feedCount: config.feeds.length,
    ingested,
    now,
  });
  const text = formatBriefText(brief);

  // ── write twice (D7): feeds/<date>.json for the UI, sources/brief-<date>.md
  //    for the knowledge system (searchable, linkable, distillable) ──
  await ensureDir(feedsDir());
  await atomicWrite(briefJsonFile(today), JSON.stringify(brief, null, 2) + "\n");
  await addSource({
    title: `Brief ${today}`,
    body: text,
    tags: ["brief"],
    origin: "brief",
  });

  return { brief, text };
}

/** Latest brief JSON on disk (for the API/UI); null when none. */
export async function latestBriefJson(): Promise<KbBrief | null> {
  try {
    const files = (await fs.readdir(feedsDir()))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    const last = files[files.length - 1];
    if (!last) return null;
    return JSON.parse(await fs.readFile(`${feedsDir()}/${last}`, "utf8")) as KbBrief;
  } catch {
    return null;
  }
}

/** True when the capability is active (used by the server to log once). */
export async function feedsConfigured(): Promise<FeedsConfig | null> {
  const config = await loadFeedsConfig();
  return config.feeds.length > 0 ? config : null;
}
