/** Assemble ImageGen-authored keyframes; no generated artwork is redrawn here. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs/design/2026-11-07-motion-samples");
assert(process.argv[2], "Usage: node scripts/build-motion-samples.mjs <source-masters-directory>");
const source = path.resolve(process.argv[2]);
const budget = 3 * 1024 * 1024;
const configs = [
  {
    id: "blink",
    name: "眨眼",
    source: "exec-613db3c2-6350-48dd-a546-584abf24c309.png",
    size: 256,
    fill: 0.9,
    frames: [0, 2, 3, 2, 0],
    delay: [2700, 70, 110, 70, 450],
  },
  {
    id: "thinking",
    name: "思考",
    source: "exec-84919767-c614-4993-947a-e41945fac28e.png",
    size: 256,
    fill: 0.88,
    frames: [0, 1, 2, 4, 2, 1, 0],
    delay: [1200, 240, 800, 130, 800, 240, 600],
  },
  {
    id: "tea",
    name: "喝茶",
    source: "exec-8c2c8cec-17f2-4e45-8a11-9088ba67ba34.png",
    size: 384,
    fill: 0.88,
    frames: [0, 1, 2, 3, 4, 3, 2, 1, 0],
    delay: [1300, 160, 170, 240, 540, 240, 170, 160, 900],
  },
  {
    id: "reading",
    name: "翻书",
    source: "exec-b7c90b20-08e6-43c1-a9bf-6eb29f868e0f.png",
    size: 384,
    fill: 0.88,
    frames: [0, 1, 2, 3, 4, 5, 6, 7, 0],
    delay: [1600, 180, 220, 250, 220, 220, 180, 260, 900],
  },
  {
    id: "gramophone",
    name: "唱机",
    source: "exec-b44d6303-c87f-481b-82a6-39bb14bb6536.png",
    size: 256,
    fill: 0.86,
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    delay: Array(8).fill(140),
  },
];
const hash = (b) => createHash("sha256").update(b).digest("hex");
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

// ImageGen does not guarantee perfectly spaced cells. Find the nine opaque
// subjects, then register their lower body/base; retain a 4px antialias margin.
function subjects(data, width, height) {
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const found = [];
  for (let p = 0; p < seen.length; p++) {
    if (seen[p] || data[p * 4 + 3] < 100) continue;
    let count = 1,
      head = 0,
      left = width,
      top = height,
      right = 0,
      bottom = 0;
    queue[0] = p;
    seen[p] = 1;
    while (head < count) {
      const q = queue[head++],
        x = q % width,
        y = Math.floor(q / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const r of [
        x > 0 ? q - 1 : -1,
        x < width - 1 ? q + 1 : -1,
        y > 0 ? q - width : -1,
        y < height - 1 ? q + width : -1,
      ]) {
        if (r >= 0 && !seen[r] && data[r * 4 + 3] >= 100) {
          seen[r] = 1;
          queue[count++] = r;
        }
      }
    }
    if (count > 10000) found.push({ left, top, right, bottom, pixels: count });
  }
  assert.equal(found.length, 9, "Expected exactly nine large connected subjects");
  found.sort((a, b) => a.top - b.top);
  const ordered = [];
  for (let r = 0; r < 3; r++)
    ordered.push(...found.slice(r * 3, r * 3 + 3).sort((a, b) => a.left - b.left));
  return ordered.map((b) => {
    let sum = 0,
      weight = 0;
    // Lower 30% avoids following the moving hands/book in the standing poses.
    for (let y = Math.round(b.top + 0.7 * (b.bottom - b.top)); y <= b.bottom; y++) {
      for (let x = b.left; x <= b.right; x++) {
        const a = data[(y * width + x) * 4 + 3];
        if (a >= 100) {
          sum += x * a;
          weight += a;
        }
      }
    }
    return { ...b, anchorX: sum / weight };
  });
}

await fs.mkdir(path.join(out, "animations"), { recursive: true });
await fs.mkdir(path.join(out, "posters"), { recursive: true });
await fs.mkdir(path.join(out, "gif"), { recursive: true });
const samples = [];
for (const cfg of configs) {
  const input = await fs.readFile(path.join(source, cfg.source));
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const boxes = subjects(data, info.width, info.height);
  const heights = boxes.map((b) => b.bottom - b.top + 1).sort((a, b) => a - b);
  const scale = (cfg.size * cfg.fill) / heights[4];
  const raws = [];
  let pngBytes = 0;
  for (const box of boxes) {
    const rect = {
      left: Math.max(0, box.left - 4),
      top: Math.max(0, box.top - 4),
      width: 0,
      height: 0,
    };
    rect.width = Math.min(info.width, box.right + 5) - rect.left;
    rect.height = Math.min(info.height, box.bottom + 5) - rect.top;
    const resized = await sharp(input)
      .extract(rect)
      .resize(Math.round(rect.width * scale), Math.round(rect.height * scale))
      .png()
      .toBuffer();
    const left = Math.round(cfg.size / 2 - (box.anchorX - rect.left) * scale);
    const top = Math.round(cfg.size * 0.94 - (box.bottom - rect.top) * scale);
    const raw = await sharp({
      create: { width: cfg.size, height: cfg.size, channels: 4, background: transparent },
    })
      .composite([{ input: resized, left, top }])
      .raw()
      .toBuffer();
    raws.push(raw);
    pngBytes += (
      await sharp(raw, { raw: { width: cfg.size, height: cfg.size, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toBuffer()
    ).length;
  }
  const raw = Buffer.concat(cfg.frames.map((i) => raws[i]));
  const anim = () =>
    sharp(raw, {
      raw: {
        width: cfg.size,
        height: cfg.size * cfg.frames.length,
        channels: 4,
        pageHeight: cfg.size,
      },
    });
  const baseOptions = { loop: 0, delay: cfg.delay };
  const lossless = await anim()
    .webp({ ...baseOptions, lossless: true, effort: 6, minSize: true })
    .toBuffer();
  const gif = await anim()
    .gif({ ...baseOptions, colours: 256, effort: 10, dither: 0.3 })
    .toBuffer();
  const candidates = [];
  for (const quality of [90, 84, 76]) {
    const buffer = await anim()
      .webp({
        ...baseOptions,
        quality,
        alphaQuality: 100,
        effort: 6,
        minSize: true,
        smartSubsample: true,
      })
      .toBuffer();
    candidates.push({ quality, buffer });
  }
  // Favour quality; the total 3 MiB ceiling is enforced below.
  const chosen = candidates[0];
  const poster = await sharp(raws[0], { raw: { width: cfg.size, height: cfg.size, channels: 4 } })
    .webp({ quality: 90, alphaQuality: 100, effort: 6 })
    .toBuffer();
  const relative = `animations/${cfg.id}.webp`;
  await fs.writeFile(path.join(out, relative), chosen.buffer);
  await fs.writeFile(path.join(out, `posters/${cfg.id}.webp`), poster);
  await fs.writeFile(path.join(out, `gif/${cfg.id}.gif`), gif);
  const meta = await sharp(chosen.buffer, { animated: true }).metadata();
  assert.equal(meta.width, cfg.size);
  assert.equal(meta.pageHeight, cfg.size);
  assert(meta.pages > 1 && meta.hasAlpha, "Animation and alpha must survive encoding");
  assert.equal(meta.loop, 0);
  assert.equal(
    meta.delay.reduce((a, b) => a + b, 0),
    cfg.delay.reduce((a, b) => a + b, 0),
  );
  const decoded = await sharp(chosen.buffer, { animated: true }).ensureAlpha().raw().toBuffer();
  const decodedHashes = new Set();
  for (let i = 0; i < meta.pages; i++)
    decodedHashes.add(
      hash(decoded.subarray(i * cfg.size * cfg.size * 4, (i + 1) * cfg.size * cfg.size * 4)),
    );
  assert(decodedHashes.size > 1, "Must have visibly distinct frames");
  samples.push({
    id: cfg.id,
    name: cfg.name,
    width: cfg.size,
    height: cfg.size,
    frames: meta.pages,
    distinctFrames: decodedHashes.size,
    durationMs: meta.delay.reduce((a, b) => a + b, 0),
    delays: meta.delay,
    webp: relative,
    poster: `posters/${cfg.id}.webp`,
    gif: `gif/${cfg.id}.gif`,
    webpBytes: chosen.buffer.length,
    posterBytes: poster.length,
    gifBytes: gif.length,
    losslessWebpBytes: lossless.length,
    nineRegisteredPngFramesBytes: pngBytes,
    quality: chosen.quality,
    candidates: candidates.map((c) => ({ quality: c.quality, bytes: c.buffer.length })),
    sourceSheet: cfg.source,
    sourceSheetBytes: input.length,
    sourceSha256: hash(input),
    sha256: hash(chosen.buffer),
    registration: { scale, boxes },
  });
  console.log(
    `${cfg.name}: ${meta.pages} frames, ${(chosen.buffer.length / 1024).toFixed(1)} KiB WebP; ${(gif.length / 1024).toFixed(1)} KiB GIF`,
  );
}
const report = {
  date: "2026-11-07",
  method:
    "Built-in ImageGen PNG keyframes, registered and encoded with sharp/libwebp; not native GPT Image 2.6 GIF output.",
  budgetBytes: budget,
  animationsBytes: samples.reduce((a, s) => a + s.webpBytes, 0),
  postersBytes: samples.reduce((a, s) => a + s.posterBytes, 0),
  gifComparisonBytes: samples.reduce((a, s) => a + s.gifBytes, 0),
  samples,
};
report.publishBytes = report.animationsBytes + report.postersBytes;
assert(report.publishBytes <= budget);
await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
await fs.writeFile(
  path.join(out, "report.js"),
  "window.LISA_MOTION = " + JSON.stringify(report) + ";\n",
);
console.log(
  JSON.stringify({
    animationsBytes: report.animationsBytes,
    publishBytes: report.publishBytes,
    budgetBytes: budget,
  }),
);
