/**
 * Embedding abstraction for semantic memory search (PLAN_MODEL_v1.0 M2).
 *
 * TF-IDF (vector.ts) stays the zero-dependency default. When LISA_EMBED_MODEL
 * is set, an Embedder provides dense vectors so search can match paraphrases
 * ("connection failed" ↔ "network error") that share no literal tokens.
 *
 * The HTTP POST is injectable so the logic is unit-testable without a running
 * embedding backend.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { localEndpoint } from "../model/local.js";

export interface Embedder {
  /** Stable id, e.g. "ollama:nomic-embed-text" — used to cache doc vectors. */
  readonly id: string;
  /** Embed each text into a dense vector. Throws if the backend is unreachable. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity in [-1, 1]; 0 for a zero or empty vector. Pure. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type PostJson = (
  url: string,
  body: unknown,
) => Promise<{ ok: boolean; status: number; body: string }>;

const defaultPostJson: PostJson = async (url, body) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
};

/** Parse Ollama's /api/embeddings response. Pure. */
export function parseOllamaEmbedding(body: string): number[] | null {
  try {
    const j = JSON.parse(body) as { embedding?: unknown };
    return Array.isArray(j.embedding) && j.embedding.every((x) => typeof x === "number")
      ? (j.embedding as number[])
      : null;
  } catch {
    return null;
  }
}

export class OllamaEmbedder implements Embedder {
  readonly id: string;
  private host: string;
  constructor(
    private model: string,
    host: string = localEndpoint("ollama").host,
    private post: PostJson = defaultPostJson,
  ) {
    this.host = host.replace(/\/$/, "");
    this.id = `ollama:${model}`;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) {
      const res = await this.post(`${this.host}/api/embeddings`, { model: this.model, prompt: t });
      const emb = res.ok ? parseOllamaEmbedding(res.body) : null;
      if (!emb) {
        throw new Error(`ollama embedding failed for "${this.model}" (status ${res.status || "unreachable"})`);
      }
      out.push(emb);
    }
    return out;
  }
}

/** The embedder configured via LISA_EMBED_MODEL, or null (→ TF-IDF default). */
export function getConfiguredEmbedder(): Embedder | null {
  const model = process.env.LISA_EMBED_MODEL?.trim();
  return model ? new OllamaEmbedder(model) : null;
}

// ── persistent embedding cache (PLAN_MODEL M2 perf) ────────────────────────
// Without this, every memory_search re-embeds ALL session docs whenever any
// session file changes (i.e. constantly during active use), which makes the
// semantic path slow + costly. Keying vectors by doc-content hash lets a
// rebuild re-embed only the docs whose content actually changed.

export type EmbeddingCache = Record<string, number[]>;

/** Stable content key for a doc text (truncated sha256). Pure. */
export function docHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * Embed `texts`, reusing `cache` for unchanged content and calling the embedder
 * only for misses (one batched call). Returns vectors in input order, an
 * `updated` cache pruned to just the current texts (no unbounded growth), and
 * the miss count. Does not mutate `cache`. Pure modulo the embedder call; the
 * caller falls back to TF-IDF if the embedder throws.
 */
export async function embedWithCache(
  texts: string[],
  embedder: Embedder,
  cache: EmbeddingCache,
): Promise<{ vectors: number[][]; updated: EmbeddingCache; misses: number }> {
  const hashes = texts.map(docHash);
  const missIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) if (!cache[hashes[i]!]) missIdx.push(i);
  const missVecs = missIdx.length ? await embedder.embed(missIdx.map((i) => texts[i]!)) : [];
  const fresh: EmbeddingCache = {};
  missIdx.forEach((i, k) => {
    fresh[hashes[i]!] = missVecs[k] ?? [];
  });
  const vectors: number[][] = new Array(texts.length);
  const updated: EmbeddingCache = {};
  for (let i = 0; i < texts.length; i++) {
    const v = fresh[hashes[i]!] ?? cache[hashes[i]!] ?? [];
    vectors[i] = v;
    updated[hashes[i]!] = v; // prune: keep only hashes for the current doc set
  }
  return { vectors, updated, misses: missIdx.length };
}

const EMBED_CACHE_DIR = path.join(LISA_HOME, "embeddings");
function embedCacheFile(embedderId: string): string {
  return path.join(EMBED_CACHE_DIR, `${embedderId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

/** Load the on-disk cache for an embedder; {} if missing/corrupt. */
export async function loadEmbeddingCache(embedderId: string): Promise<EmbeddingCache> {
  try {
    return JSON.parse(await fs.readFile(embedCacheFile(embedderId), "utf8")) as EmbeddingCache;
  } catch {
    return {};
  }
}

/** Persist the cache for an embedder. Best-effort (never throws). */
export async function saveEmbeddingCache(embedderId: string, cache: EmbeddingCache): Promise<void> {
  try {
    await fs.mkdir(EMBED_CACHE_DIR, { recursive: true });
    await fs.writeFile(embedCacheFile(embedderId), JSON.stringify(cache));
  } catch {
    // best-effort; a missing cache just means more re-embedding next time
  }
}
