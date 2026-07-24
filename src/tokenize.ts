/**
 * Shared TF-IDF tokenizer for the two local search indexes (kb/search.ts over
 * the knowledge base, memory/vector.ts over session transcripts).
 *
 * Both used to carry their own copy of the same three lines:
 *
 *   text.toLowerCase().replace(/[^a-z0-9CJK\s]/g, " ").split(/\s+/)
 *
 * which is correct for space-delimited languages and silently broken for CJK.
 * Chinese/Japanese text has no spaces, so a whole clause survived as ONE token:
 *
 *   doc   "这篇公众号文章讲的是知识库的设计" → ["这篇公众号文章讲的是知识库的设计"]
 *   query "知识库"                          → ["知识库"]
 *   intersection = ∅ → zero hits
 *
 * i.e. CJK content was only findable by an exact, whole-clause query — which no
 * one types. The fix is character bigrams: for each CJK run we emit the run
 * itself (so an exact phrase still ranks highest) plus every 2-gram (so any
 * substring query matches). Bigram indexing is the standard dictionary-free
 * approach for CJK retrieval and needs no segmentation model; IDF takes care of
 * the noise from bigrams that straddle word boundaries.
 *
 * Runs are segmented at the CJK/latin boundary first, so "gpt模型" indexes as
 * "gpt" + the CJK bigrams rather than one unmatchable blob.
 */

/**
 * Kept characters: latin alphanumerics, CJK Unified Ideographs (+ Extension A),
 * and Japanese kana. Everything else becomes a separator. Kana and Ext-A are new
 * — the old class dropped them entirely, so Japanese text indexed as nothing.
 */
const NON_WORD = /[^a-z0-9぀-ヿ㐀-䶿一-鿿\s]/g;

const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿]/;

/** Split a run at every latin↔CJK boundary. "gpt模型v2" → ["gpt", "模型", "v2"]. */
function segment(run: string): string[] {
  const out: string[] = [];
  let start = 0;
  let cjk = CJK_CHAR.test(run[0]!);
  for (let i = 1; i < run.length; i++) {
    const isCjk = CJK_CHAR.test(run[i]!);
    if (isCjk !== cjk) {
      out.push(run.slice(start, i));
      start = i;
      cjk = isCjk;
    }
  }
  out.push(run.slice(start));
  return out;
}

/** Stopwords shared by both indexes. Callers may pass a superset. */
export const BASE_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "to", "in", "and", "or", "for", "is", "it",
  "this", "that", "be", "are", "was", "were", "with", "on", "as", "at",
  "by", "from", "but", "not", "i", "you", "we", "they", "he", "she",
]);

/**
 * Tokenize for TF-IDF. Latin words pass through as before (lowercased, ≥2
 * chars, stopwords dropped); CJK runs additionally yield their bigrams.
 *
 * Stopwords are only applied to latin tokens: a CJK bigram is a fragment, not a
 * word, so a stoplist would be meaningless there (IDF handles common bigrams).
 */
export function tokenize(
  text: string,
  stopwords: ReadonlySet<string> = BASE_STOPWORDS,
): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().replace(NON_WORD, " ").split(/\s+/)) {
    if (!run) continue;
    for (const seg of segment(run)) {
      if (!seg) continue;
      if (CJK_CHAR.test(seg)) {
        // A lone CJK character is often a whole word (书, 猫) — keep it. The old
        // length>=2 filter dropped those. At length 2 the run IS its only
        // bigram, so emit it once rather than double-counting its term freq.
        out.push(seg);
        if (seg.length > 2) {
          for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
        }
      } else if (seg.length >= 2 && !stopwords.has(seg)) {
        out.push(seg);
      }
    }
  }
  return out;
}
