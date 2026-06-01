#!/usr/bin/env tsx
/**
 * Generate Lisa's macOS app icon via Seedream — the canonical pixel-art
 * hoodie girl (same character/style as the website mascot), but on a FLAT
 * solid non-white background with NO glow / aura, plus native rounded corners.
 *
 *   SEEDREAM_API_KEY=... npx tsx scripts/generate-app-icon.ts
 *   ICON_BG=#16323a ...    # the solid background colour (also named in prompt)
 *   ICON_BG_NAME="dark teal"
 *   ICON_PROMPT="..."      # override the whole prompt
 *
 * Output: packaging/mac-client/Resources/app-icon-1024.png
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const API_KEY = process.env.SEEDREAM_API_KEY;
if (!API_KEY) {
  console.error(
    "SEEDREAM_API_KEY is not set. Export it or add it to ~/.lisa/config.env, then re-run.",
  );
  process.exit(1);
}

const SEEDREAM_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const SEEDREAM_MODEL = "doubao-seedream-5-0-260128";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../packaging/mac-client/Resources/app-icon-1024.png");

const SIZE = 1024;
const RADIUS = 224;

function hexToRGB(hex: string) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
const BG_HEX = process.env.ICON_BG ?? "#16323A";
const BG_NAME = process.env.ICON_BG_NAME ?? "dark teal-blue";
const BG = hexToRGB(BG_HEX);

// Same character as the mascot / STYLE_LOCK, but explicitly FLAT + no glow.
const PROMPT =
  process.env.ICON_PROMPT ??
  [
    "16-bit pixel-art portrait of the recurring character LISA:",
    "a young woman with chin-length cyan / teal hair and a side-swept fringe, kind blue eyes,",
    "fair skin with a faint pink blush, a gentle closed-mouth smile,",
    "wearing a soft hooded sweater with a subtle circuit-board pattern in cool tones (navy / cyan / purple).",
    "Tight close-up head-and-shoulders bust that FILLS the frame, cropped close, minimal background margin.",
    "Limited ~24-colour palette, crisp 1px outlines, clean dithering, Stardew-Valley / Celeste portrait sprite style.",
    `IMPORTANT: a completely FLAT plain solid ${BG_NAME} background.`,
    "Absolutely NO glow, NO aura, NO halo, NO gradient, NO rim light, NO sparkles, no scene.",
    "No text, no signature, no watermark, no logo.",
  ].join(" ");

interface SeedreamResponse { data?: { url?: string }[]; error?: { message?: string } }

async function callSeedream(prompt: string): Promise<string> {
  const res = await fetch(SEEDREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
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

console.log(`→ generating icon via Seedream (bg=${BG_NAME} ${BG_HEX})…`);
const url = await callSeedream(PROMPT);
const raw = Buffer.from(await (await fetch(url)).arrayBuffer());

// Zoom the subject so Lisa fills more of the icon: crop a centred (slightly
// top-biased, to keep the head) fraction of the art before fitting to 1024.
const meta = await sharp(raw).metadata();
const ZOOM = parseFloat(process.env.ICON_ZOOM ?? "1.35");
const cw = Math.round((meta.width ?? SIZE) / ZOOM);
const ch = Math.round((meta.height ?? SIZE) / ZOOM);
const cl = Math.round(((meta.width ?? SIZE) - cw) / 2);
const ct = Math.round(((meta.height ?? SIZE) - ch) * 0.15);
const zoomed = await sharp(raw).extract({ left: cl, top: ct, width: cw, height: ch }).toBuffer();
const art = await sharp(zoomed).resize(SIZE, SIZE, { fit: "cover", position: "top" }).toBuffer();
const mask = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`,
);

await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { ...BG, alpha: 1 } } })
  .composite([{ input: art }, { input: mask, blend: "dest-in" }])
  .png()
  .toFile(OUT);

console.log(`✓ wrote ${OUT}`);
