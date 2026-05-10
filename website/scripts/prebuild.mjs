/**
 * Pre-build step for the website:
 *   1. Snapshot scripts/lisa-moods.ts → website/src/data/moods.json so
 *      Astro pages can import the data without a TS resolution dance.
 *   2. Symlink src/web/assets/ → website/public/assets so the existing
 *      114 mood portraits + base UI assets are served from the website
 *      under /assets/* without duplicating files.
 *
 * Idempotent: safe to re-run.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.dirname(HERE);
const REPO_ROOT = path.dirname(WEBSITE_ROOT);

// 1. Snapshot mood data ────────────────────────────────────────────────
const moodsTs = await fs.readFile(
  path.join(REPO_ROOT, "scripts", "lisa-moods.ts"),
  "utf8",
);

// Extract MOODS array via regex — fragile but avoids needing tsx as a dep
// just for this. The data layout is stable; if it ever changes shape, the
// regex will fail loudly.
const arrayMatch = /export const MOODS:\s*MoodSpec\[\]\s*=\s*\[([\s\S]*?)\n\];/.exec(moodsTs);
if (!arrayMatch) throw new Error("Could not extract MOODS from lisa-moods.ts");

const entryRe = /\{\s*slug:\s*"([^"]+)",\s*category:\s*"([^"]+)",\s*hint:\s*"([^"]+)",\s*prompt:\s*"([^"]+)"\s*\}/g;
const moods = [];
let m;
while ((m = entryRe.exec(arrayMatch[1])) !== null) {
  moods.push({ slug: m[1], category: m[2], hint: m[3], prompt: m[4] });
}

// Also extract STYLE_LOCK for full reproducibility on the gallery page.
const styleMatch = /export const STYLE_LOCK\s*=\s*\[([\s\S]*?)\]\.join\(/m.exec(moodsTs);
let styleLock = "";
if (styleMatch) {
  const lines = [...styleMatch[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  styleLock = lines.join(" ");
}

const outDir = path.join(WEBSITE_ROOT, "src", "data");
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(
  path.join(outDir, "moods.json"),
  JSON.stringify({ styleLock, moods }, null, 2),
);
console.log(`✓ wrote moods.json (${moods.length} moods)`);

// 2. Symlink assets ─────────────────────────────────────────────────────
const publicDir = path.join(WEBSITE_ROOT, "public");
await fs.mkdir(publicDir, { recursive: true });
const linkPath = path.join(publicDir, "assets");
const targetPath = path.join(REPO_ROOT, "src", "web", "assets");
try {
  await fs.unlink(linkPath);
} catch {
  /* not present */
}
await fs.symlink(targetPath, linkPath, "dir");
console.log(`✓ symlinked public/assets → ${path.relative(WEBSITE_ROOT, targetPath)}`);
