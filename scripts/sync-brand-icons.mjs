/** Keep Mac, web app and website branding on the same unmodified master.
 * Run from any directory: node scripts/sync-brand-icons.mjs
 * The master was extracted from the owner's installed Lisa.app on 2026-11-07.
 * Website filenames include the source digest to bypass old immutable caches.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = await fs.readFile(
  path.join(root, "packaging/mac-client/Resources/app-icon-1024.png"),
);
const metadata = await sharp(master).metadata();
if (metadata.width !== 1024 || metadata.height !== 1024)
  throw new Error("Expected a 1024×1024 Mac icon");
const digest = createHash("sha256").update(master).digest("hex").slice(0, 12);
const assets = path.join(root, "src/web/assets");
await fs.writeFile(path.join(assets, "lisa-app-icon.png"), master);
execFileSync(
  process.execPath,
  ["--import", "tsx", "scripts/optimize-assets.ts", "--icons", "--filter", "__icons_only__"],
  { cwd: root, stdio: "pipe" },
);

const publicDir = path.join(root, "website/public");
const iconDir = path.join(publicDir, "icons");
await fs.mkdir(iconDir, { recursive: true });
const appIcon = `/icons/lisa-${digest}.png`;
const favicon = `/icons/lisa-${digest}-32.png`;
const appleTouchIcon = `/icons/lisa-${digest}-180.png`;
await fs.writeFile(path.join(publicDir, appIcon.slice(1)), master);
const small = await sharp(master).resize(32, 32).png().toBuffer();
await fs.writeFile(path.join(publicDir, favicon.slice(1)), small);
await fs.copyFile(
  path.join(assets, "apple-touch-icon.png"),
  path.join(publicDir, appleTouchIcon.slice(1)),
);

// PNG-backed ICO for browsers/tools that request /favicon.ico directly.
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = header[7] = 32;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(small.length, 14);
header.writeUInt32LE(22, 18);
await fs.writeFile(path.join(publicDir, "favicon.ico"), Buffer.concat([header, small]));
await fs.mkdir(path.join(root, "website/src/data"), { recursive: true });
await fs.writeFile(
  path.join(root, "website/src/data/brand.json"),
  JSON.stringify({ appIcon, favicon, appleTouchIcon }, null, 2) + "\n",
);
console.log(`Synced Mac/web/website icons from ${digest}`);
