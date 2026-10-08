/** Portable review gallery, served independently of a running Lisa backend. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "src/web/assets/visuals/soft-ink-v1");
const review = path.join(root, "docs/design/2026-10-08-visual-refresh");
const manifest = JSON.parse(await fs.readFile(path.join(assets, "manifest.json"), "utf8"));
for (const kind of ["portraits", "poses", "scenes", "stickers"]) {
  manifest[kind].src = "soft-ink-sources/" + kind + ".png";
}
delete manifest.portraits.smallSrc;
const renderer = await fs.readFile(path.join(root, "src/web/assets/client/soft-ink.js"), "utf8");
let html = await fs.readFile(path.join(assets, "gallery.html"), "utf8");
html = html.replace(
  '<script src="manifest.js"></script><script src="../../client/soft-ink.js"></script>',
  "<script>window.LISA_ART = " + JSON.stringify(manifest) + ";\n" + renderer + "</script>",
);
html = html
  .replaceAll("/assets/icon-192.png", "soft-ink-sources/icon-master.png")
  .replaceAll('src="room.webp"', 'src="soft-ink-sources/room.png"')
  .replaceAll('src="sunroom.webp"', 'src="soft-ink-sources/sunroom.png"')
  .replaceAll("'stickers/'+slug", "'assets/soft-ink-stickers/'+slug")
  .replace('href="prompts.txt"', 'href="soft-ink-prompts.txt"')
  .replace(
    " · B / Soft Ink · 2026-10-08",
    ' · <a href="proposal.html">原始三方向提案</a> · <a href="implementation.html">实现范围与验证</a> · B / Soft Ink · 2026-10-08',
  );
await fs.cp(path.join(assets, "stickers"), path.join(review, "assets/soft-ink-stickers"), {
  recursive: true,
});
await fs.copyFile(path.join(assets, "prompts.txt"), path.join(review, "soft-ink-prompts.txt"));
await fs.writeFile(path.join(review, "index.html"), html);
console.log("Soft Ink review gallery updated; original proposal preserved as proposal.html.");
