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
