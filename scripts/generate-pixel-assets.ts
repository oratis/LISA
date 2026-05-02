#!/usr/bin/env tsx
/**
 * Generate Lisa's pixel-art GUI assets via the Seedream image generation API,
 * post-process with `sharp` to chroma-key near-white pixels to transparent
 * (the lightweight server-side equivalent of the bg-remove project's RMBG-1.4
 * pipeline — that project is browser-only, so we use sharp here).
 *
 * Usage:
 *   SEEDREAM_API_KEY=... npx tsx scripts/generate-pixel-assets.ts
 *
 * Outputs land in src/web/assets/.
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
  console.error(
    "SEEDREAM_API_KEY is not set. Get a key at https://www.volcengine.com/product/ark and either export it in your shell or add it to ~/.lisa/config.env.",
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "src", "web", "assets");

interface Asset {
  filename: string;
  prompt: string;
  size: "2K";
  /** If true, chroma-key near-white background to transparent. */
  cutout: boolean;
  /** Optional downscale (square pixels). Pixel-art icons read fine at 256-512px. */
  downscaleTo?: number;
}

const ASSETS: Asset[] = [
  {
    filename: "lisa-mascot.png",
    size: "2K",
    cutout: true,
    prompt:
      "16-bit pixel art portrait of LISA, a friendly cyan-haired girl AI assistant with kind blue eyes and a soft smile, wearing a hooded sweater with subtle circuit-board patterns. Centered front-facing bust shot. Limited palette (~24 colors), crisp 1px outlines, clean dithering, tasteful pixel anti-aliasing. Pure white background (#FFFFFF) for chroma key. Inspired by Stardew Valley and Celeste portrait sprites. No text, no signature, no watermark.",
  },
  {
    filename: "background-tile.png",
    size: "2K",
    cutout: false,
    prompt:
      "Seamless 16-bit pixel art tileable background pattern. Soft dark navy night sky with tiny twinkling stars and faint diagonal scanlines. Subtle gradient from #0a1233 to #1a2a5e. Very low contrast so text stays readable on top. No subjects, no characters, just an ambient cozy CRT vibe.",
  },
  {
    filename: "icon-send.png",
    size: "2K",
    cutout: true,
    downscaleTo: 256,
    prompt:
      "16-bit pixel art icon of a glowing paper airplane flying right, leaving a short pixel motion trail. Bright cyan + white highlights. Centered subject filling ~70% of frame. Clean 1px outlines. Pure white background (#FFFFFF) for chroma key. No text.",
  },
  {
    filename: "icon-skill.png",
    size: "2K",
    cutout: true,
    downscaleTo: 256,
    prompt:
      "16-bit pixel art icon of an open spellbook with a glowing star floating above its pages. Warm gold + magenta. Centered subject. Clean 1px outlines, classic JRPG inventory icon vibe. Pure white background (#FFFFFF) for chroma key. No text.",
  },
  {
    filename: "icon-memory.png",
    size: "2K",
    cutout: true,
    downscaleTo: 256,
    prompt:
      "16-bit pixel art icon of a glowing pixel-art brain with a small heart inside, faint sparkle particles. Soft pink + cyan. Centered, isometric-ish. Clean 1px outlines, JRPG inventory icon feel. Pure white background (#FFFFFF) for chroma key. No text.",
  },
  {
    filename: "icon-tool.png",
    size: "2K",
    cutout: true,
    downscaleTo: 256,
    prompt:
      "16-bit pixel art icon of a crossed wrench and gear, vintage workshop palette (orange, brown, steel grey). Centered, filling ~70% of frame. Clean 1px outlines. Pure white background (#FFFFFF) for chroma key. No text.",
  },
  {
    filename: "icon-soul.png",
    size: "2K",
    cutout: true,
    downscaleTo: 256,
    prompt:
      "16-bit pixel art icon of a glowing soul orb — a translucent teal-and-cyan flame held inside an open palm-shaped silhouette, surrounded by faint sparkle particles and tiny floating stars. Mystical and warm, suggesting an inner life. Centered, filling ~70% of frame. Clean 1px outlines, classic JRPG inventory icon vibe. Pure white background (#FFFFFF) for chroma key. No text.",
  },
];

interface SeedreamResponse {
  data?: { url?: string }[];
  error?: { message?: string };
}

async function callSeedream(prompt: string, size: "2K"): Promise<string> {
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
  if (!res.ok) {
    throw new Error(`Seedream HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let payload: SeedreamResponse;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Seedream returned non-JSON: ${text.slice(0, 200)}`);
  }
  const url = payload.data?.[0]?.url;
  if (!url) {
    throw new Error(
      `Seedream returned no URL. body=${JSON.stringify(payload).slice(0, 400)}`,
    );
  }
  return url;
}

async function downloadPng(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Chroma-key near-white pixels to transparent. Equivalent to running the
 * bg-remove RMBG-1.4 pipeline for clean studio-white inputs, but a few hundred
 * MB lighter and a few seconds faster.
 */
async function chromaKeyWhite(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.from(data);
  const threshold = 240; // pixels with R/G/B all >= threshold become transparent
  const feather = 20; // and pixels in [threshold-feather, threshold] get partial alpha
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = out[idx]!;
      const g = out[idx + 1]!;
      const b = out[idx + 2]!;
      const minVal = Math.min(r, g, b);
      if (minVal >= threshold) {
        out[idx + 3] = 0;
      } else if (minVal >= threshold - feather) {
        const t = (minVal - (threshold - feather)) / feather;
        out[idx + 3] = Math.round((1 - t) * 255);
      }
    }
  }
  return await sharp(out, { raw: { width, height, channels } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function generateOne(asset: Asset): Promise<void> {
  const outPath = path.join(OUT_DIR, asset.filename);
  process.stdout.write(`→ ${asset.filename} (${asset.size}) ... `);
  const url = await callSeedream(asset.prompt, asset.size);
  let png = await downloadPng(url);
  if (asset.downscaleTo) {
    png = await sharp(png)
      .resize(asset.downscaleTo, asset.downscaleTo, { kernel: "nearest" })
      .png()
      .toBuffer();
  }
  const final = asset.cutout ? await chromaKeyWhite(png) : png;
  await fs.writeFile(outPath, final);
  process.stdout.write(`OK (${final.byteLength} bytes)\n`);
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const filter = process.argv[2];
  for (const asset of ASSETS) {
    if (filter && !asset.filename.includes(filter)) continue;
    try {
      await generateOne(asset);
    } catch (err) {
      console.error(`✗ ${asset.filename}: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
