/** Encode ImageGen's transparent seated poses without retouching the artwork.
 * Fixed quadrant extraction + transparent trim are delivery operations only.
 * Contact coordinates locate the pelvis in each trimmed image, in percent.
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = path.join(root, "docs/design/2026-10-09-room-integration/seated-poses-master.png");
const target = path.join(root, "src/web/assets/visuals/soft-ink-room-v2");
await fs.mkdir(target, { recursive: true });
const { width, height } = await sharp(master).metadata();
const poses = {};
const specs = [
  ["sleep", 24, [79, 82]],
  ["read", 19.5, [69, 68]],
  ["work", 21.5, [78, 67]],
  ["tea", 18.5, [68, 69]],
];
for (const [index, [name, roomWidth, contact]] of specs.entries()) {
  const left = Math.round(((index % 2) * width) / 2);
  const top = Math.round((Math.floor(index / 2) * height) / 2);
  const cell = await sharp(master)
    .extract({ left, top, width: Math.floor(width / 2), height: Math.floor(height / 2) })
    .png()
    .toBuffer();
  const { data, info } = await sharp(cell)
    .trim({ threshold: 5 })
    .webp({ quality: 93, alphaQuality: 100, effort: 6 })
    .toBuffer({ resolveWithObject: true });
  await fs.writeFile(path.join(target, name + ".webp"), data);
  poses[name] = {
    src: "/assets/visuals/soft-ink-room-v2/" + name + ".webp",
    aspect: info.width / info.height,
    width: roomWidth,
    contact,
  };
  console.log(name, info.width, info.height, Math.round(data.length / 1024) + " KiB");
}
await fs.writeFile(
  path.join(target, "manifest.json"),
  JSON.stringify({ version: "soft-ink-room-v2", poses }, null, 2) + "\n",
);
