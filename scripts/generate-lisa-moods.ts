#!/usr/bin/env tsx
/**
 * Generate Lisa's mood/state portrait set via Seedream + sharp transparency.
 *
 * Runs MOODS in parallel batches to stay polite to the API (default 4 concurrent).
 * Skips files that already exist on disk so it's safe to re-run / resume.
 *
 *   npx tsx scripts/generate-lisa-moods.ts                 # generate all missing
 *   npx tsx scripts/generate-lisa-moods.ts --force         # regenerate all
 *   npx tsx scripts/generate-lisa-moods.ts --limit 5       # just 5 new ones
 *   npx tsx scripts/generate-lisa-moods.ts --filter happy  # only matching slugs
 *   CONCURRENCY=8 npx tsx scripts/generate-lisa-moods.ts   # tweak parallelism
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { MOODS, STYLE_LOCK, type MoodSpec } from "./lisa-moods.js";

const SEEDREAM_URL =
  "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const SEEDREAM_MODEL = "doubao-seedream-5-0-260128";
const API_KEY = process.env.SEEDREAM_API_KEY;
if (!API_KEY) {
  console.error(
    "SEEDREAM_API_KEY is not set. Get a key at https://www.volcengine.com/product/ark and either export it in your shell or add it to ~/.lisa/config.env.",
  );
  process.exit(1);
}
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY ?? "4", 10));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "src", "web", "assets", "lisa");

interface SeedreamResponse {
  data?: { url?: string }[];
  error?: { message?: string };
}

async function callSeedream(prompt: string): Promise<string> {
  const res = await fetch(SEEDREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: SEEDREAM_MODEL,
      prompt,
      sequential_image_generation: "disabled",
      response_format: "url",
      size: "2K",
      stream: false,
      watermark: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const payload = JSON.parse(text) as SeedreamResponse;
  const url = payload.data?.[0]?.url;
  if (!url) throw new Error(`no url in response: ${text.slice(0, 200)}`);
  return url;
}

async function downloadPng(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function chromaKeyWhite(input: Buffer, finalSize: number): Promise<Buffer> {
  const resized = await sharp(input)
    .resize(finalSize, finalSize, { kernel: "nearest" })
    .png()
    .toBuffer();
  const { data, info } = await sharp(resized)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.from(data);
  const threshold = 235; // R/G/B all >= → candidate "white"
  const feather = 15;    // softening band for anti-aliased borders
  const N = width * height;

  // 1. Mark candidate-white pixels.
  const candidate = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += channels) {
    const minVal = Math.min(out[p]!, out[p + 1]!, out[p + 2]!);
    if (minVal >= threshold - feather) candidate[i] = 1;
  }

  // 2. Flood-fill candidates connected to ANY edge pixel.
  // BFS using a typed-array ring queue.
  const reached = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qHead = 0;
  let qTail = 0;
  const enqueue = (idx: number) => {
    if (reached[idx] || !candidate[idx]) return;
    reached[idx] = 1;
    queue[qTail++] = idx;
  };
  for (let x = 0; x < width; x++) {
    enqueue(x);                          // top edge
    enqueue((height - 1) * width + x);   // bottom edge
  }
  for (let y = 0; y < height; y++) {
    enqueue(y * width);                  // left edge
    enqueue(y * width + width - 1);      // right edge
  }
  while (qHead < qTail) {
    const idx = queue[qHead++]!;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0)          enqueue(idx - 1);
    if (x < width - 1)  enqueue(idx + 1);
    if (y > 0)          enqueue(idx - width);
    if (y < height - 1) enqueue(idx + width);
  }

  // 3. Apply alpha only to edge-connected white. Feather based on whiteness.
  for (let i = 0, p = 0; i < N; i++, p += channels) {
    if (!reached[i]) continue;
    const minVal = Math.min(out[p]!, out[p + 1]!, out[p + 2]!);
    if (minVal >= threshold) {
      out[p + 3] = 0;
    } else if (minVal >= threshold - feather) {
      const t = (minVal - (threshold - feather)) / feather;
      out[p + 3] = Math.round((1 - t) * 255);
    }
  }

  return await sharp(out, { raw: { width, height, channels } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function generateOne(mood: MoodSpec, force: boolean): Promise<string> {
  const outPath = path.join(OUT_DIR, `${mood.slug}.png`);
  if (!force) {
    try {
      await fs.access(outPath);
      return "skip";
    } catch {}
  }
  const fullPrompt = `${STYLE_LOCK} ${mood.prompt}.`;
  const url = await callSeedream(fullPrompt);
  const png = await downloadPng(url);
  const final = await chromaKeyWhite(png, 512);
  await fs.writeFile(outPath, final);
  return `${final.byteLength}B`;
}

async function runBatched<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onResult: (item: T, result: R | Error, index: number) => void,
): Promise<void> {
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = nextIndex++;
          if (i >= items.length) return;
          const item = items[i]!;
          try {
            const r = await fn(item, i);
            onResult(item, r, i);
          } catch (err) {
            onResult(item, err as Error, i);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;

  let queue = MOODS.filter((m) => !filter || m.slug.includes(filter));
  if (!force) {
    const fresh: MoodSpec[] = [];
    for (const mood of queue) {
      try {
        await fs.access(path.join(OUT_DIR, `${mood.slug}.png`));
      } catch {
        fresh.push(mood);
      }
    }
    queue = fresh;
  }
  if (limit > 0) queue = queue.slice(0, limit);

  console.log(
    `Generating ${queue.length}/${MOODS.length} moods to ${OUT_DIR} (concurrency=${CONCURRENCY})…`,
  );
  const start = Date.now();
  let done = 0;
  let failed = 0;
  await runBatched(queue, CONCURRENCY, async (mood) => generateOne(mood, force), (mood, result, i) => {
    done++;
    if (result instanceof Error) {
      failed++;
      console.error(`[${done}/${queue.length}] ✗ ${mood.slug}: ${result.message}`);
    } else {
      console.log(`[${done}/${queue.length}] ✓ ${mood.slug} (${result})`);
    }
  });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${secs}s — ${done - failed} ok, ${failed} failed.`);

  // Write a manifest so the runtime knows what's available without scanning.
  const present = await fs.readdir(OUT_DIR);
  const manifest = MOODS.filter((m) => present.includes(`${m.slug}.png`)).map(
    (m) => ({ slug: m.slug, category: m.category, hint: m.hint }),
  );
  await fs.writeFile(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify({ count: manifest.length, moods: manifest }, null, 2),
  );
  console.log(`Wrote manifest: ${manifest.length} entries`);
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
