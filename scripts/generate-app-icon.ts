#!/usr/bin/env tsx
/**
 * Generate Lisa's macOS app icon — a simple pixel-art girl on a solid
 * background. No image API needed: the sprite is drawn from primitives on a
 * small grid, then nearest-neighbour upscaled so the pixels stay crisp.
 *
 *   npx tsx scripts/generate-app-icon.ts
 *
 * Output: packaging/mac-client/Resources/app-icon-1024.png
 * build.sh turns that into AppIcon.icns.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../packaging/mac-client/Resources/app-icon-1024.png");

// ── palette (RGB) ────────────────────────────────────────────────────
const C = {
  bg:        [0xf4, 0xe8, 0xd0], // solid warm cream
  hair:      [0x5c, 0xd0, 0xda], // cyan — her canonical hair
  hairDark:  [0x33, 0xa6, 0xb3],
  skin:      [0xff, 0xd9, 0xb4],
  skinDark:  [0xf0, 0xbc, 0x95],
  eye:       [0x26, 0x31, 0x4c],
  blush:     [0xff, 0x9f, 0xa0],
  mouth:     [0xd2, 0x72, 0x8a],
  sweater:   [0x3e, 0x4f, 0x97],
  sweaterD:  [0x2f, 0x3c, 0x76],
  outline:   [0x1e, 0x24, 0x36],
} as const;
type Col = readonly [number, number, number];

const N = 22; // sprite grid (kept small → "simpler", crisp pixels)
const grid: (Col | null)[] = new Array(N * N).fill(null); // null = background

const idx = (x: number, y: number) => y * N + x;
function set(x: number, y: number, c: Col) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  grid[idx(x, y)] = c;
}
/** Draw + mirror across the vertical centre line (cx = (N-1)/2 = 10.5). */
function setM(x: number, y: number, c: Col) {
  set(x, y, c);
  set(N - 1 - x, y, c);
}
function ellipse(cx: number, cy: number, rx: number, ry: number, c: Col, pred?: (x: number, y: number) => boolean) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1 && (!pred || pred(x, y))) set(x, y, c);
    }
  }
}

const CX = 10.5;

// 1. hair (back) — frames the face and falls to chin length
ellipse(CX, 9.0, 7.2, 7.6, C.hair);
// 2. sweater / shoulders — wide ellipse at the bottom
ellipse(CX, 23, 9.5, 5.5, C.sweater, (_, y) => y >= 16);
// 3. face
ellipse(CX, 10, 5.4, 6.4, C.skin);
// 4. neck
for (let y = 15; y <= 16; y++) for (let x = 9; x <= 12; x++) set(x, y, C.skin);
// 5. fringe / bangs — hair covering the top of the forehead, side-swept
ellipse(CX, 10, 5.4, 6.4, C.hair, (_, y) => y <= 6);
setM(5, 7, C.hair); // a little fringe sweeping down the sides
setM(5, 8, C.hair);
// 6. eyes — clean symmetric 2×2 blocks (mirrored across centre)
for (const ex of [7, 8]) {
  setM(ex, 10, C.eye);
  setM(ex, 11, C.eye);
}
// 7. blush — on the cheeks, just under/outside the eyes
setM(6, 12, C.blush);
setM(7, 12, C.blush);
// 9. mouth — small smile
set(10, 13, C.mouth); set(11, 13, C.mouth);
// 10. chin shading
setM(7, 14, C.skinDark);

// 11. 1px dark outline around the whole silhouette (sticker look)
const isFig = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && grid[idx(x, y)] !== null;
const outlinePts: [number, number][] = [];
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (grid[idx(x, y)] !== null) continue;
    if (isFig(x - 1, y) || isFig(x + 1, y) || isFig(x, y - 1) || isFig(x, y + 1)) {
      outlinePts.push([x, y]);
    }
  }
}
for (const [x, y] of outlinePts) grid[idx(x, y)] = C.outline;

// ── rasterise grid → RGBA buffer on the solid background ──────────────
const buf = Buffer.alloc(N * N * 4);
for (let i = 0; i < N * N; i++) {
  const c = grid[i] ?? C.bg;
  buf[i * 4 + 0] = c[0];
  buf[i * 4 + 1] = c[1];
  buf[i * 4 + 2] = c[2];
  buf[i * 4 + 3] = 255;
}

// ASCII preview to stdout for a quick sanity check
let preview = "";
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const c = grid[idx(x, y)];
    preview += c === null ? "·" : c === C.hair || c === C.hairDark ? "#" : c === C.skin || c === C.skinDark ? "o" : c === C.outline ? " " : c === C.sweater ? "=" : c === C.eye ? "e" : "*";
  }
  preview += "\n";
}
console.log(preview);

await sharp(buf, { raw: { width: N, height: N, channels: 4 } })
  .resize(1024, 1024, { kernel: "nearest" })
  .png()
  .toFile(OUT);

console.log(`✓ wrote ${OUT}`);
