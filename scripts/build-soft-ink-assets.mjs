/** Web delivery encodings. Unmodified ImageGen PNG masters remain in docs/. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "docs/design/2026-10-08-visual-refresh/soft-ink-sources");
const output = path.join(root, "src/web/assets/visuals/soft-ink-v1");
for (const name of ["portraits", "poses", "stickers", "scenes", "room", "sunroom"]) {
  const master = path.join(source, name + ".png");
  const encoded = await sharp(master)
    .webp({ quality: 92, alphaQuality: 100, effort: 6 })
    .toBuffer();
  await fs.writeFile(path.join(output, name + ".webp"), encoded);
  console.log(name + ".webp: " + Math.round(encoded.length / 1024) + " KiB");
}
// UIKit's conservative compatibility path stays PNG; current browser clients use WebP.
await fs.copyFile(path.join(source, "portraits.png"), path.join(output, "portraits.png"));
await sharp(path.join(source, "portraits.png"))
  .resize(768, 512)
  .webp({ quality: 82, alphaQuality: 100, effort: 6 })
  .toFile(path.join(output, "portraits-small.webp"));
const sceneSheet = path.join(source, "scenes.png");
const sceneSize = await sharp(sceneSheet).metadata();
await sharp(sceneSheet)
  .extract({
    left: 0,
    top: 0,
    width: Math.floor(sceneSize.width / 3),
    height: Math.floor(sceneSize.height / 2),
  })
  .resize(256, 256)
  .webp({ quality: 86, alphaQuality: 100 })
  .toFile(path.join(output, "welcome.webp"));

// Package the generated atlas into ordinary downloadable PNG files. This is
// the same fixed cell extraction used by the renderer, with no art retouching.
const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
const sheet = path.join(source, "stickers.png");
const { width, height } = await sharp(sheet).metadata();
await fs.mkdir(path.join(output, "stickers"), { recursive: true });
for (let index = 0; index < manifest.stickers.labels.length; index++) {
  const col = index % manifest.stickers.columns;
  const row = Math.floor(index / manifest.stickers.columns);
  const left = Math.round((col * width) / manifest.stickers.columns);
  const top = Math.round((row * height) / manifest.stickers.rows);
  const right = Math.round(((col + 1) * width) / manifest.stickers.columns);
  const bottom = Math.round(((row + 1) * height) / manifest.stickers.rows);
  const slug = manifest.stickers.labels[index].toLowerCase().replaceAll(" ", "-");
  await sharp(sheet)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(path.join(output, "stickers", "lisa-" + slug + ".png"));
}
