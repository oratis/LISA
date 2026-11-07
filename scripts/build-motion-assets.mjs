/** Deterministic assembly of ImageGen keyframes. Source masters stay outside the shipped pack. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { register } from "./lib/motion-frames.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "src/web/assets/visuals/soft-ink-motion-v1");
const configPath = path.join(root, "docs/design/2026-11-07-motion-samples/production-sources.json");
const configs = JSON.parse(await fs.readFile(configPath, "utf8"));
assert(
  process.argv[2],
  "Usage: node scripts/build-motion-assets.mjs <source-masters-directory> [clip-id ...]",
);
const source = path.resolve(process.argv[2]);
const only = new Set(process.argv.slice(3));
for (const id of only)
  assert(
    configs.some((cfg) => cfg.id === id),
    "Unknown clip: " + id,
  );
const jobs = only.size ? configs.filter((cfg) => only.has(cfg.id)) : configs;
const prefix = "/assets/visuals/soft-ink-motion-v1/";
const portraitIds = [
  "blink",
  "happy",
  "laughing",
  "giggling",
  "thinking",
  "confused",
  "surprised",
  "worried",
  "sad",
  "apologetic",
  "grateful",
  "proud",
  "determined",
  "excited",
  "cheering",
  "sleepy",
  "working",
  "debugging",
  "research",
  "writing",
  "portrait-reading",
  "portrait-tea",
  "portrait-stretching",
  "portrait-napping",
];
const manifest = {
  version: 1,
  maxAnimationBytes: 256 * 1024,
  portraits: Object.fromEntries(portraitIds.map((id, index) => [index, id])),
  poses: [
    "standing",
    "standing",
    "seated",
    "sleeping",
    "looking-up",
    "reading",
    "tea",
    "stretching",
    "listening",
    "window",
    "pajamas",
    "gramophone",
  ],
  stickers: [
    "sticker-hello",
    "sticker-well-done",
    "sticker-thinking",
    "sticker-thank-you",
    "sticker-celebrate",
    "sticker-here-for-you",
    "sticker-make-a-plan",
    "sticker-tea-break",
  ],
  clips: {},
};
const reportPath = path.join(root, "docs/design/2026-11-07-motion-samples/production-report.json");
const report = only.size
  ? JSON.parse(await fs.readFile(reportPath, "utf8")).clips.filter((clip) => !only.has(clip.id))
  : [];
if (only.size)
  manifest.clips = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8")).clips;
await fs.mkdir(out, { recursive: true });
async function buildClip(cfg) {
  const input = await fs.readFile(path.join(source, cfg.source));
  const raws = await register(input, cfg.size, cfg.fill || 0.88);
  const raw = Buffer.concat(cfg.frames.map((i) => raws[i]));
  const image = () =>
    sharp(raw, {
      raw: {
        width: cfg.size,
        height: cfg.size * cfg.frames.length,
        channels: 4,
        pageHeight: cfg.size,
      },
    });
  const webp = await image()
    .webp({
      loop: 0,
      delay: cfg.delay,
      quality: 84,
      alphaQuality: 100,
      effort: 6,
      minSize: true,
      smartSubsample: true,
    })
    .toBuffer();
  assert(webp.length <= manifest.maxAnimationBytes, cfg.id + " WebP exceeds 256 KiB");
  const poster = await sharp(raws[0], { raw: { width: cfg.size, height: cfg.size, channels: 4 } })
    .webp({ quality: 88, alphaQuality: 100, effort: 6 })
    .toBuffer();
  await fs.writeFile(path.join(out, cfg.id + ".webp"), webp);
  await fs.writeFile(path.join(out, cfg.id + "-static.webp"), poster);
  const meta = await sharp(webp, { animated: true }).metadata();
  assert(meta.pages > 1 && meta.hasAlpha);
  const clip = {
    src: prefix + cfg.id + ".webp",
    poster: prefix + cfg.id + "-static.webp",
    width: cfg.size,
    height: cfg.size,
    frames: meta.pages,
    durationMs: cfg.delay.reduce((a, b) => a + b, 0),
    bytes: webp.length,
    posterBytes: poster.length,
  };
  let nativeBytes = 0;
  if (portraitIds.includes(cfg.id) || cfg.id.startsWith("sticker-")) {
    const gif = await image()
      .gif({ loop: 0, delay: cfg.delay, colours: 256, effort: 7, dither: 0.3 })
      .toBuffer();
    await fs.writeFile(path.join(out, cfg.id + ".gif"), gif);
    clip.native = prefix + cfg.id + ".gif";
    nativeBytes = gif.length;
    clip.nativeBytes = gif.length;
    assert(gif.length <= manifest.maxAnimationBytes, cfg.id + " GIF exceeds 256 KiB");
  }
  manifest.clips[cfg.id] = clip;
  report.push({
    id: cfg.id,
    animationBytes: webp.length,
    posterBytes: poster.length,
    nativeBytes,
    sourceSha256: createHash("sha256").update(input).digest("hex"),
  });
  console.log(cfg.id, webp.length + poster.length + nativeBytes);
}
let cursor = 0;
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (cursor < jobs.length) await buildClip(jobs[cursor++]);
  }),
);
manifest.clips = Object.fromEntries(configs.map((cfg) => [cfg.id, manifest.clips[cfg.id]]));
report.sort(
  (a, b) => configs.findIndex((c) => c.id === a.id) - configs.findIndex((c) => c.id === b.id),
);
for (const id of new Set([
  ...Object.values(manifest.portraits),
  ...manifest.poses,
  ...manifest.stickers,
]))
  assert(manifest.clips[id], "Missing animation: " + id);
await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await fs.writeFile(
  path.join(out, "manifest.js"),
  "window.LISA_MOTION_ART = " + JSON.stringify(manifest) + ";\n",
);
const assetsBytes = (
  await Promise.all(
    (await fs.readdir(out)).map(async (f) => (await fs.stat(path.join(out, f))).size),
  )
).reduce((a, b) => a + b, 0);
const controllerBytes = (
  await Promise.all(
    ["motion.js", "room-effects.js"].map(
      async (f) => (await fs.stat(path.join(root, "src/web/assets/client", f))).size,
    ),
  )
).reduce((a, b) => a + b, 0);
await fs.writeFile(
  path.join(root, "docs/design/2026-11-07-motion-samples/production-report.json"),
  JSON.stringify(
    {
      assetsBytes,
      controllerBytes,
      totalBytes: assetsBytes + controllerBytes,
      maxAnimationBytes: manifest.maxAnimationBytes,
      clips: report,
    },
    null,
    2,
  ) + "\n",
);
console.log({
  assetsBytes,
  controllerBytes,
  totalMiB: (assetsBytes + controllerBytes) / 1024 / 1024,
});
