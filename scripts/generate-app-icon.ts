#!/usr/bin/env tsx
/**
 * Generate Lisa's macOS app icon via Seedream — a cute chibi catgirl avatar
 * in the style of the supplied reference, Lisa-flavoured (her signature
 * cyan/teal hair), on a clean solid background with native rounded corners.
 *
 *   SEEDREAM_API_KEY=... npx tsx scripts/generate-app-icon.ts
 *   ICON_BG=#EAF2FF ...  # override the solid background colour
 *   ICON_PROMPT="..."    # override the whole prompt
 *
 * Output: packaging/mac-client/Resources/app-icon-1024.png
 * build.sh turns that into AppIcon.icns.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const API_KEY = process.env.SEEDREAM_API_KEY;
if (!API_KEY) {
  console.error(
    "SEEDREAM_API_KEY is not set.\n" +
      "Get a key at https://www.volcengine.com/product/ark and either export it\n" +
      "in your shell or add it to ~/.lisa/config.env, then re-run.",
  );
  process.exit(1);
}

const SEEDREAM_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const SEEDREAM_MODEL = "doubao-seedream-5-0-260128";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../packaging/mac-client/Resources/app-icon-1024.png");

const SIZE = 1024;
const RADIUS = 224; // macOS squircle-ish corner radius

function hexToRGB(hex: string) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
const BG = hexToRGB(process.env.ICON_BG ?? "#F2F1EC");

// Prompt tuned to the reference: cute chibi catgirl avatar, big glossy teal
// eyes, soft bangs, fluffy cat ears, blush, a tiny black cat hair-clip, small
// white paw-print accents — kept "Lisa" via her cyan/teal hair. Plain solid
// background + centred head-and-shoulders = clean app-icon composition.
const PROMPT =
  process.env.ICON_PROMPT ??
  [
    "Cute chibi anime girl avatar icon, kawaii profile-picture style.",
    "Big round sparkling teal-blue eyes with bright highlights, tiny gentle smile, soft pink blush on the cheeks.",
    "Chin-length fluffy CYAN / TEAL hair with soft straight bangs (this is the recurring character LISA).",
    "Fluffy matching cat ears with pale-pink inner ears; a small black cat-shaped hair clip.",
    "A few little white paw-print marks floating near the top corners.",
    "Centered head-and-shoulders bust, facing forward.",
    "Clean thick outlines, soft cel shading, gentle pastel palette.",
    "Plain solid off-white background, flat, no scene, no props.",
    "Absolutely no text, no signature, no watermark, no logo.",
  ].join(" ");

interface SeedreamResponse {
  data?: { url?: string }[];
  error?: { message?: string };
}

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

console.log("→ generating icon via Seedream…");
const url = await callSeedream(PROMPT);
const raw = Buffer.from(await (await fetch(url)).arrayBuffer());

// Square-crop to centre, resize, composite onto the solid background (in case
// the art has any transparency / off-square), then clip to rounded corners.
const art = await sharp(raw)
  .resize(SIZE, SIZE, { fit: "cover", position: "top" })
  .toBuffer();

const mask = Buffer.from(
  `<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`,
);

await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { ...BG, alpha: 1 } } })
  .composite([{ input: art }, { input: mask, blend: "dest-in" }])
  .png()
  .toFile(OUT);

console.log(`✓ wrote ${OUT}`);
