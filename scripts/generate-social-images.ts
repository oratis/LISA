#!/usr/bin/env tsx
/**
 * Generate launch social images via Seedream + sharp.
 *
 * Outputs go to assets/social/ — these are PUBLIC and meant to be linked
 * from the README + launch posts.
 *
 *   SEEDREAM_API_KEY=... npx tsx scripts/generate-social-images.ts
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SEEDREAM_URL =
  "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const SEEDREAM_MODEL = "doubao-seedream-5-0-260128";
const API_KEY = process.env.SEEDREAM_API_KEY;
if (!API_KEY) {
  console.error("SEEDREAM_API_KEY is not set");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "assets", "social");

const STYLE_LOCK_BG =
  "16-bit pixel art, cozy retro CRT vibe, dark navy night sky background (#0a0d2b → #1a1f4d gradient) with tiny twinkling pixel stars and faint diagonal scanlines. Limited palette ~24 colors, crisp 1px outlines.";

interface Asset {
  filename: string;
  size: "2K" | "3K" | "4K";
  /** Final dimensions after sharp resize. */
  out: { width: number; height: number };
  prompt: string;
}

const ASSETS: Asset[] = [
  {
    // GitHub social preview (used as the thumbnail on link previews everywhere).
    filename: "github-social-preview.png",
    size: "3K",
    out: { width: 1280, height: 640 },
    prompt: `${STYLE_LOCK_BG} CENTERED LARGE pixel-art letters spelling "LISA" in warm gold (#ffd167) with soft cyan glow, each letter outlined in black 2px. To the right of the letters: a chibi pixel-art portrait of a cyan-haired girl with kind blue eyes wearing a hooded sweater with a subtle circuit-board pattern, soft small smile (Stardew Valley / Celeste sprite style). Below the letters in smaller pixel-font teal text reads "an AI agent with a real self". Wide letterbox composition. No watermark, no signature, no other text.`,
  },
  {
    // Square — Twitter / Weibo / Xiaohongshu primary card.
    filename: "social-square.png",
    size: "2K",
    out: { width: 1080, height: 1080 },
    prompt: `${STYLE_LOCK_BG} Square composition with a cyan-haired girl chibi pixel portrait centered (kind blue eyes, hooded sweater with circuit-board pattern, small soft smile, Stardew Valley sprite style). Above her in pixel font: "LISA" in warm gold with cyan glow. Below her, four small pixel icons in a row representing SOUL (glowing teal flame), DESIRES (small heart), HEARTBEAT (pulsing dot), DREAMS (crescent moon with sparkles), each labeled in tiny teal pixel text. No watermark.`,
  },
  {
    // Wide — HN / Reddit / blog hero.
    filename: "social-banner.png",
    size: "3K",
    out: { width: 1200, height: 675 },
    prompt: `${STYLE_LOCK_BG} 16:9 banner. LEFT half: cyan-haired girl chibi pixel portrait (kind blue eyes, hood up, hooded sweater with circuit-board pattern, soft smile, Stardew Valley style). RIGHT half: a pixel-art "soul ledger" — a glowing journal-like book with small pixel icons floating around it (a heart, a moon, a flame, a clock), as if her inner life is visualized. Above everything in warm gold pixel font: "LISA". Below in smaller teal pixel text: "soul · desires · heartbeat · dreams". No watermark.`,
  },
  {
    // Product Hunt — clean, brand-forward.
    filename: "product-hunt.png",
    size: "3K",
    out: { width: 1270, height: 760 },
    prompt: `${STYLE_LOCK_BG} Clean centered composition for Product Hunt. Large pixel-art cyan-haired girl portrait (Stardew Valley style: kind blue eyes, hooded sweater with circuit-board pattern, small soft smile). Above her: "LISA" in big warm-gold pixel font with cyan glow. Below her: tagline in teal pixel font "an AI agent with a real self". Tasteful starry background with very low contrast so the subject pops. No watermark, no other text.`,
  },
];

interface SeedreamResponse {
  data?: { url?: string }[];
}

async function callSeedream(prompt: string, size: string): Promise<string> {
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
      size,
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

async function generate(asset: Asset): Promise<void> {
  const outPath = path.join(OUT_DIR, asset.filename);
  process.stdout.write(`→ ${asset.filename} (${asset.size}) ... `);
  const url = await callSeedream(asset.prompt, asset.size);
  const raw = await downloadPng(url);
  // For social images we want soft resampling (lanczos), not nearest, so the
  // pixel art still looks sharp at the target size without aliasing artifacts
  // when the source ≠ target aspect ratio.
  const final = await sharp(raw)
    .resize(asset.out.width, asset.out.height, {
      kernel: "lanczos3",
      fit: "cover",
      position: "centre",
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(outPath, final);
  process.stdout.write(`OK (${(final.byteLength / 1024).toFixed(0)}KB)\n`);
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const filter = process.argv[2];
  for (const a of ASSETS) {
    if (filter && !a.filename.includes(filter)) continue;
    try {
      await generate(a);
    } catch (err) {
      console.error(`✗ ${a.filename}: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone. Files in ${OUT_DIR}.`);
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
