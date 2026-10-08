/** Standard native/PWA size exports from the approved, unmodified ImageGen master. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const master = path.join(
  root,
  "docs/design/2026-10-08-visual-refresh/soft-ink-sources/icon-master.png",
);
const exports = [
  ["src/web/assets/lisa-app-icon.png", 1024],
  ["src/web/assets/lisa-mascot.png", 256],
  ["packaging/mac-client/Resources/app-icon-1024.png", 1024],
  ["packaging/ios-companion/Sources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png", 1024],
  ["packaging/mac-client/Resources/MenuBarIcon.png", 64],
];
for (const [file, size] of exports) {
  const out = await sharp(master)
    .resize(size, size)
    .flatten({ background: "#dff7ef" })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(path.join(root, file), out);
  console.log(file + " " + size + "×" + size);
}
