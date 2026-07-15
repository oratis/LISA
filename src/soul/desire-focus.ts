/**
 * Intra-session focus (PLAN_DESIRE_EVOLUTION_v1.0 §6 F1, the conservative
 * variant): while a conversation is live, surface the EXISTING desire it's
 * about — so the "current desire" tracks the conversation at turn granularity,
 * not just at reflection pauses.
 *
 * Deliberately cheap and safe, per Debate 4's concerns:
 *  - Pure lexical overlap. NO per-turn LLM call, NO persisted state.
 *  - Display-only. It never writes a desire; it only chooses which existing one
 *    to show. When nothing matches clearly it returns null and the caller falls
 *    back to the recency pick (pickCurrentDesire), so it can't invent focus.
 *  - Cross-lingual: matches English word tokens AND CJK character bigrams, so it
 *    works when Lisa and the user converse in Chinese (no segmenter needed).
 */
import type { DesireEntry } from "./types.js";
import type { StoredMessage } from "../types.js";

/** How recently the conversation must have been active for focus to apply. Past
 *  this, a "focus" derived from old messages is stale — fall back to recency. */
export const FOCUS_FRESHNESS_MS = 15 * 60_000;

/** Minimum shared tokens for a desire to count as "what this is about". */
export const FOCUS_MIN_OVERLAP = 2;

// Small English stoplist — the frequent glue words that would create spurious
// overlap. Intentionally short; rarer words carry the signal.
const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "that", "this", "with", "have", "has",
  "was", "are", "but", "not", "can", "will", "would", "about", "what", "how",
  "why", "when", "which", "them", "they", "from", "into", "out", "get", "got",
  "want", "wanted", "like", "just", "some", "any", "all", "one", "two", "more",
  "she", "her", "his", "him", "its", "our", "their", "been", "being", "there",
]);

/**
 * Tokenize into a comparable set: lowercased latin word-tokens (len ≥ 3, minus
 * stopwords) plus CJK character bigrams within each contiguous CJK run. Pure.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]{3,}/g)) {
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  }
  // Contiguous CJK runs (Han + kana + Hangul) → overlapping 2-char shingles.
  for (const m of text.matchAll(/[一-鿿぀-ヿ가-힯]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/**
 * Pick the desire the recent conversation is clearly about, or null. Scores each
 * desire by token overlap with `recentText`; returns the STRICT top scorer when
 * it clears FOCUS_MIN_OVERLAP. A tie (no single desire is clearly the subject)
 * returns null so the caller can fall back to the recency pick rather than pick
 * arbitrarily. Pure.
 */
export function pickFocusedDesire(
  desires: DesireEntry[],
  recentText: string,
  opts: { minOverlap?: number } = {},
): DesireEntry | null {
  const min = opts.minOverlap ?? FOCUS_MIN_OVERLAP;
  const convo = tokenize(recentText);
  if (convo.size === 0) return null;
  let best: DesireEntry | null = null;
  let bestScore = 0;
  let tied = false;
  for (const d of desires) {
    const dt = tokenize(`${d.what} ${d.why}`);
    let score = 0;
    for (const t of dt) if (convo.has(t)) score++;
    if (score > bestScore) {
      best = d;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  if (bestScore < min || tied) return null;
  return best;
}

/** Join the last `maxMessages` user-authored messages into one string for
 *  matching. Latest-weighted context of what the user is actually talking about. */
export function recentUserText(
  history: readonly StoredMessage[],
  maxMessages = 3,
): string {
  const texts: string[] = [];
  for (let i = history.length - 1; i >= 0 && texts.length < maxMessages; i--) {
    const m = history[i];
    if (!m || m.role !== "user") continue;
    const t = messageText(m.content);
    if (t.trim()) texts.push(t);
  }
  return texts.reverse().join(" ");
}

function messageText(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && "text" in b && typeof b.text === "string"
        ? b.text
        : "",
    )
    .join(" ");
}
