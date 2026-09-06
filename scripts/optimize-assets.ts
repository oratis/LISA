#!/usr/bin/env tsx
/**
 * Lossless-first PNG optimiser for `src/web/assets` (v0.24 review, UX-7 / T-9).
 *
 * Every PNG is decoded with sharp, re-encoded a few ways, and a candidate is
 * accepted ONLY if decoding it gives byte-identical RGBA to the original AND
 * it is strictly smaller than the file on disk. This is pixel art: a single
 * changed pixel is a regression, so nothing here is "visually" lossless — a
 * candidate is exact or it is rejected. Filenames, dimensions, alpha and
 * colour are untouched, so no reference in `src/web/*.ts` needs to change.
 *
 * Candidates (sharp / libvips only — no new dependencies):
 *   1. truecolour, zlib level 9, adaptive row filtering  (wins for RGBA art)
 *   2. truecolour, zlib level 9, no row filtering        (wins for flat/noisy)
 *   3. palette — only when the image has ≤ 256 distinct RGBA colours:
 *      libimagequant at quality 100 / effort 10 / no dither, which is exact
 *      for ≤ 256 colours (lower effort is NOT — it approximates), and is
 *      verified like everything else.
 *
 * Chunk policy: sharp strips every ancillary chunk and adds its own `pHYs`.
 * Colour-space chunks (gAMA, cHRM, sRGB, iCCP) change how Firefox / Safari
 * colour-manage an image, so they are copied from the original verbatim.
 * Pure metadata (pHYs, eXIf, tEXt/iTXt/zTXt, tIME) is dropped after asserting
 * the EXIF carries no orientation. A file with any other ancillary chunk
 * (bKGD, sBIT, acTL/APNG, …) is left untouched rather than guessed at.
 *
 * Usage:
 *   npx tsx scripts/optimize-assets.ts                # optimise in place, print tables
 *   npx tsx scripts/optimize-assets.ts --dry-run      # measure only, write nothing
 *   npx tsx scripts/optimize-assets.ts --filter lisa/ # subset (substring of relative path)
 *   npx tsx scripts/optimize-assets.ts --estimate     # force the WebP / duplicate table
 *   npx tsx scripts/optimize-assets.ts --icons        # regenerate icon-192/512 +
 *                                                     # apple-touch-icon from lisa-app-icon.png
 *   npx tsx scripts/optimize-assets.ts --jobs 8 --top 30
 *
 * Idempotent: a second run finds no strictly smaller exact candidate and
 * writes nothing. Exit code is 1 if any file failed to process.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "src", "web", "assets");
const ICON_MASTER = "lisa-app-icon.png";
/** UX-7 / T-9 target for the whole npm unpack; above it we print the estimate table. */
const TARGET_BYTES = 15 * 1024 * 1024;

// ─── CLI ────────────────────────────────────────────────────────────────────

interface Args {
  dryRun: boolean;
  filter: string | undefined;
  estimate: boolean;
  icons: boolean;
  jobs: number;
  top: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, filter: undefined, estimate: false, icons: false, jobs: 4, top: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--estimate") args.estimate = true;
    else if (a === "--icons") args.icons = true;
    else if (a === "--filter") args.filter = argv[++i];
    else if (a === "--jobs") args.jobs = Math.max(1, parseInt(argv[++i] ?? "4", 10) || 4);
    else if (a === "--top") args.top = Math.max(1, parseInt(argv[++i] ?? "20", 10) || 20);
    else if (a === "--help" || a === "-h") {
      console.log("usage: optimize-assets.ts [--dry-run] [--filter <substr>] [--estimate] [--icons] [--jobs N] [--top N]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// ─── PNG chunk plumbing ─────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks the encoder owns; anything else sharp emits (pHYs) is dropped. */
const ENCODER_OWNED = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
/** Colour-space chunks: copied from the original verbatim (they affect rendering). */
const KEEP_CHUNKS = new Set(["gAMA", "cHRM", "sRGB", "iCCP"]);
/** Metadata-only chunks: safe to drop (EXIF orientation is asserted absent first). */
const DROP_CHUNKS = new Set(["pHYs", "eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

interface Chunk {
  type: string;
  data: Buffer;
}

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function parseChunks(buf: Buffer): Chunk[] {
  if (buf.length < PNG_SIG.length || !buf.subarray(0, PNG_SIG.length).equals(PNG_SIG)) {
    throw new Error("not a PNG (bad signature)");
  }
  const chunks: Chunk[] = [];
  let p = PNG_SIG.length;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const end = p + 12 + len;
    if (end > buf.length) throw new Error(`truncated ${type} chunk`);
    if (buf.readUInt32BE(p + 8 + len) !== crc32(buf.subarray(p + 4, p + 8 + len))) {
      throw new Error(`bad CRC in ${type} chunk`);
    }
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p = end;
    if (type === "IEND") break;
  }
  if (chunks[0]?.type !== "IHDR") throw new Error("first chunk is not IHDR");
  if (chunks[chunks.length - 1]?.type !== "IEND") throw new Error("missing IEND");
  return chunks;
}

function serialiseChunks(chunks: Chunk[]): Buffer {
  const parts: Buffer[] = [PNG_SIG];
  for (const c of chunks) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(c.data.length, 0);
    head.write(c.type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), c.data])), 0);
    parts.push(head, c.data, crc);
  }
  return Buffer.concat(parts);
}

/**
 * Take sharp's encoder output, keep only the chunks it owns, and re-insert the
 * original's colour-space chunks straight after IHDR (they must precede PLTE
 * and IDAT). CRCs are recomputed, so the result is a well-formed PNG.
 */
function rebuildWithColourChunks(encoded: Buffer, original: Chunk[]): Buffer {
  const enc = parseChunks(encoded).filter((c) => ENCODER_OWNED.has(c.type));
  const [ihdr, ...rest] = enc;
  if (!ihdr) throw new Error("encoder output has no IHDR");
  const keep = original.filter((c) => KEEP_CHUNKS.has(c.type));
  return serialiseChunks([ihdr, ...keep, ...rest]);
}

// ─── decoding / comparison ──────────────────────────────────────────────────

interface Decoded {
  width: number;
  height: number;
  hasAlpha: boolean;
  depth: string;
  orientation: number | undefined;
  /** Always 4 channels (RGBA), 8-bit. */
  rgba: Buffer;
}

async function decode(buf: Buffer): Promise<Decoded> {
  const meta = await sharp(buf).metadata();
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected 4 channels after ensureAlpha, got ${info.channels}`);
  return {
    width: info.width,
    height: info.height,
    hasAlpha: meta.hasAlpha ?? false,
    depth: meta.depth ?? "unknown",
    orientation: meta.orientation,
    rgba: data,
  };
}

function isExact(ref: Decoded, cand: Decoded): boolean {
  return (
    ref.width === cand.width &&
    ref.height === cand.height &&
    ref.hasAlpha === cand.hasAlpha &&
    ref.rgba.equals(cand.rgba)
  );
}

/** Distinct RGBA colours, and whether every pixel is fully opaque. */
function countColours(rgba: Buffer): { colours: number; allOpaque: boolean } {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >>> 2);
  const seen = new Set<number>();
  let allOpaque = true;
  for (let i = 0; i < u32.length; i++) {
    const v = u32[i]!;
    seen.add(v);
    if ((v >>> 24) !== 0xff && allOpaque) allOpaque = false;
  }
  return { colours: seen.size, allOpaque };
}

// ─── per-file optimisation ──────────────────────────────────────────────────

interface FileResult {
  rel: string;
  dir: string;
  before: number;
  after: number;
  method: string;
  /** Number of exact-decode assertions that passed for this file. */
  assertions: number;
  colours: number;
  allOpaque: boolean;
  width: number;
  height: number;
  hasAlpha: boolean;
  fileHash: string;
  pixelHash: string;
  skipped?: string;
  /** Size of the smallest exact candidate even when it was not smaller than the original. */
  bestCandidate: number;
  /** Only filled by the estimate pass. */
  webpLossless?: number;
  webpVisiblyExact?: boolean;
}

interface Candidate {
  name: string;
  encode: () => Promise<Buffer>;
}

async function optimiseFile(rel: string, dryRun: boolean): Promise<FileResult> {
  const abs = path.join(ASSETS_DIR, rel);
  const buf = await fs.readFile(abs);
  const dir = path.dirname(rel) === "." ? "(root)" : path.dirname(rel) + "/";
  const base: FileResult = {
    rel, dir, before: buf.length, after: buf.length, method: "unchanged", assertions: 0,
    colours: 0, allOpaque: false, width: 0, height: 0, hasAlpha: false,
    fileHash: createHash("sha256").update(buf).digest("hex"), pixelHash: "", bestCandidate: buf.length,
  };

  const chunks = parseChunks(buf);
  const unknown = chunks
    .map((c) => c.type)
    .filter((t) => !ENCODER_OWNED.has(t) && !KEEP_CHUNKS.has(t) && !DROP_CHUNKS.has(t));
  const ref = await decode(buf);
  const { colours, allOpaque } = countColours(ref.rgba);
  Object.assign(base, {
    colours, allOpaque, width: ref.width, height: ref.height, hasAlpha: ref.hasAlpha,
    pixelHash: createHash("sha256").update(ref.rgba).digest("hex"),
  });

  if (unknown.length) return { ...base, skipped: `unhandled ancillary chunk(s): ${unknown.join(", ")}` };
  if (ref.depth !== "uchar") return { ...base, skipped: `unsupported bit depth (${ref.depth})` };
  if (ref.orientation !== undefined && ref.orientation !== 1) {
    return { ...base, skipped: `EXIF orientation ${ref.orientation} would be lost` };
  }

  const candidates: Candidate[] = [
    {
      name: "truecolour+adaptive",
      encode: () => sharp(buf).png({ palette: false, compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    },
    {
      name: "truecolour",
      encode: () => sharp(buf).png({ palette: false, compressionLevel: 9, adaptiveFiltering: false }).toBuffer(),
    },
  ];
  if (colours <= 256) {
    candidates.push({
      name: `palette(${colours})`,
      encode: () =>
        sharp(buf)
          .png({ palette: true, colours: Math.max(2, colours), quality: 100, effort: 10, dither: 0, compressionLevel: 9 })
          .toBuffer(),
    });
  }

  let best: { name: string; bytes: Buffer } | undefined;
  let assertions = 0;
  for (const cand of candidates) {
    let out: Buffer;
    try {
      out = rebuildWithColourChunks(await cand.encode(), chunks);
    } catch (err) {
      console.warn(`  ! ${rel}: ${cand.name} failed to encode: ${(err as Error).message}`);
      continue;
    }
    const exact = isExact(ref, await decode(out));
    if (!exact) {
      // Not a bug in the pipeline for palette: libimagequant may still approximate.
      console.warn(`  ! ${rel}: ${cand.name} is NOT pixel-identical — rejected`);
      continue;
    }
    assertions++;
    if (!best || out.length < best.bytes.length) best = { name: cand.name, bytes: out };
  }

  if (!best) return { ...base, assertions, skipped: "no exact candidate" };
  if (best.bytes.length >= buf.length) {
    return { ...base, assertions, method: "already optimal", bestCandidate: best.bytes.length };
  }

  if (!dryRun) {
    // Write next to the target and rename, so a crash never leaves a half file.
    const tmp = `${abs}.optimize-tmp`;
    await fs.writeFile(tmp, best.bytes);
    await fs.rename(tmp, abs);
    // Final assertion: what is on disk decodes to exactly the original pixels.
    const onDisk = await fs.readFile(abs);
    if (!onDisk.equals(best.bytes) || !isExact(ref, await decode(onDisk))) {
      await fs.writeFile(abs, buf); // restore the original bytes
      throw new Error(`${rel}: post-write verification failed — original restored`);
    }
    assertions++;
  }
  return { ...base, after: best.bytes.length, method: best.name, assertions, bestCandidate: best.bytes.length };
}

// ─── derived icons ──────────────────────────────────────────────────────────

interface DerivedIcon {
  file: string;
  size: number;
  /** Inset the art so nothing important can be cropped by a maskable mask. */
  maskable: boolean;
  purpose: string;
}

const DERIVED_ICONS: DerivedIcon[] = [
  { file: "icon-192.png", size: 192, maskable: true, purpose: 'web manifest, purpose "any maskable"' },
  { file: "icon-512.png", size: 512, maskable: true, purpose: 'web manifest, purpose "any maskable"' },
  { file: "apple-touch-icon.png", size: 180, maskable: false, purpose: "iOS home screen (iOS applies its own superellipse mask)" },
];

/** Maskable safe zone: a circle of diameter 80% of the icon, i.e. radius 0.4 × size. */
const MASKABLE_SAFE_RADIUS = 0.4;
/** Channel tolerance when deciding whether a pixel is "the flat field" or "art". */
const FIELD_TOLERANCE = 12;

/** Modal fully-opaque colour in the outer `band` fraction — the flat field colour. */
function sampleFieldColour(ref: Decoded, bandFraction = 0.06): { r: number; g: number; b: number } {
  const band = Math.max(1, Math.round(ref.width * bandFraction));
  const counts = new Map<number, number>();
  for (let y = 0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const inBand = x < band || y < band || x >= ref.width - band || y >= ref.height - band;
      if (!inBand) continue;
      const p = (y * ref.width + x) * 4;
      if (ref.rgba[p + 3] !== 0xff) continue;
      const key = (ref.rgba[p]! << 16) | (ref.rgba[p + 1]! << 8) | ref.rgba[p + 2]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let field = 0;
  let bestCount = -1;
  for (const [key, n] of counts) if (n > bestCount) { field = key; bestCount = n; }
  return { r: (field >> 16) & 0xff, g: (field >> 8) & 0xff, b: field & 0xff };
}

/**
 * Largest distance from the centre, in units of image width, of any pixel that
 * is neither transparent nor the flat field colour. Everything beyond that
 * radius is background, so cropping it costs nothing.
 */
function artRadius(ref: Decoded, field: { r: number; g: number; b: number }): number {
  const cx = (ref.width - 1) / 2;
  const cy = (ref.height - 1) / 2;
  let maxR = 0;
  for (let y = 0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const p = (y * ref.width + x) * 4;
      if (ref.rgba[p + 3]! < 8) continue;
      if (
        Math.abs(ref.rgba[p]! - field.r) <= FIELD_TOLERANCE &&
        Math.abs(ref.rgba[p + 1]! - field.g) <= FIELD_TOLERANCE &&
        Math.abs(ref.rgba[p + 2]! - field.b) <= FIELD_TOLERANCE
      ) continue;
      const r = Math.hypot(x - cx, y - cy);
      if (r > maxR) maxR = r;
    }
  }
  return maxR / ref.width;
}

/**
 * Derive the manifest / touch icons from `lisa-app-icon.png`.
 *
 * The master is a rounded square on a flat teal field, and the pixel-art bust
 * bleeds to all four edges (measured art bbox is the full 512², max art radius
 * ≈ 0.616 × width). A full-bleed maskable icon would therefore have the top of
 * the head and the shoulders cropped by an aggressive mask, so the manifest
 * icons inset the art until every non-field pixel falls inside the maskable
 * safe zone (the central 80% circle) and pad the rest with the field colour
 * sampled from the master's own border — the padding is invisible because it
 * is the same colour the art already ends in.
 *
 * apple-touch-icon is deliberately NOT inset: iOS masks with a superellipse
 * that trims only the corners, and an inset icon would sit visibly smaller
 * than every other icon on the home screen. It only needs to be opaque, since
 * iOS composites transparency onto black.
 */
async function deriveIcons(dryRun: boolean): Promise<void> {
  const masterAbs = path.join(ASSETS_DIR, ICON_MASTER);
  const master = await fs.readFile(masterAbs);
  const masterChunks = parseChunks(master);
  const ref = await decode(master);
  if (ref.width !== ref.height) throw new Error(`${ICON_MASTER} must be square, got ${ref.width}x${ref.height}`);

  const background = sampleFieldColour(ref);
  const hex = `#${background.r.toString(16).padStart(2, "0")}${background.g.toString(16).padStart(2, "0")}${background.b.toString(16).padStart(2, "0")}`;
  const radius = artRadius(ref, background);
  // Round DOWN to 1/100 so the inset always has a little slack over the measurement.
  const maskableScale = Math.min(1, Math.floor((MASKABLE_SAFE_RADIUS / radius) * 100) / 100);
  console.log(
    `icons: master ${ICON_MASTER} ${ref.width}×${ref.height}, field ${hex}, ` +
      `art radius ${radius.toFixed(4)}×size → maskable inset scale ${maskableScale.toFixed(2)}`,
  );

  for (const icon of DERIVED_ICONS) {
    const inner = icon.maskable ? Math.round(icon.size * maskableScale) : icon.size;
    const pad = icon.size - inner;
    const left = Math.floor(pad / 2);
    const top = Math.floor(pad / 2);

    let pipeline = sharp(master);
    if (inner !== ref.width) pipeline = pipeline.resize(inner, inner, { kernel: "lanczos3", fit: "fill" });
    // flatten first so the master's transparent rounded corners become field
    // colour; extend then continues that field out to the full icon square.
    pipeline = pipeline.flatten({ background });
    if (pad > 0) {
      pipeline = pipeline.extend({ top, left, bottom: pad - top, right: pad - left, background });
    }
    // Same chunk policy as the optimiser (master's colour-space chunks kept,
    // sharp's pHYs dropped) so a follow-up `optimize-assets` run is a no-op.
    const out = rebuildWithColourChunks(
      await pipeline.png({ palette: false, compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
      masterChunks,
    );

    const check = await decode(out);
    if (check.width !== icon.size || check.height !== icon.size || check.hasAlpha) {
      throw new Error(
        `${icon.file}: expected opaque ${icon.size}×${icon.size}, got ${check.width}×${check.height} alpha=${check.hasAlpha}`,
      );
    }
    // The whole point of the inset: assert it actually landed inside the safe circle.
    const outRadius = artRadius(check, background);
    if (icon.maskable && outRadius > MASKABLE_SAFE_RADIUS) {
      throw new Error(
        `${icon.file}: art reaches ${outRadius.toFixed(4)}×size, outside the maskable safe zone (${MASKABLE_SAFE_RADIUS})`,
      );
    }

    const abs = path.join(ASSETS_DIR, icon.file);
    const existing = await fs.readFile(abs).catch(() => undefined);
    // Compare decoded pixels, not bytes: the optimiser may have losslessly
    // re-encoded the file since, and that must not count as "out of date".
    const same = existing !== undefined && isExact(check, await decode(existing));
    if (same) {
      console.log(`  = ${icon.file} ${icon.size}×${icon.size} up to date — ${icon.purpose}`);
      continue;
    }
    if (!dryRun) await fs.writeFile(abs, out);
    console.log(
      `  ${dryRun ? "~" : "+"} ${icon.file} ${icon.size}×${icon.size} ${fmtBytes(out.length)}, ` +
        `art ${inner}px (radius ${outRadius.toFixed(3)}×size) — ${icon.purpose}`,
    );
  }
}

// ─── estimate pass (WebP lossless + duplicates) ─────────────────────────────

async function estimateWebp(r: FileResult): Promise<void> {
  const buf = await fs.readFile(path.join(ASSETS_DIR, r.rel));
  const ref = await decode(buf);
  const webp = await sharp(buf).webp({ lossless: true, effort: 6 }).toBuffer();
  const dec = await decode(webp);
  // libwebp "lossless" keeps alpha and every visible pixel exact but is free to
  // rewrite RGB under alpha = 0 — so compare only what can ever be displayed.
  let visiblyExact = dec.width === ref.width && dec.height === ref.height;
  for (let p = 0; visiblyExact && p < ref.rgba.length; p += 4) {
    const a = ref.rgba[p + 3];
    if (a !== dec.rgba[p + 3]) visiblyExact = false;
    else if (a !== 0 && (ref.rgba[p] !== dec.rgba[p] || ref.rgba[p + 1] !== dec.rgba[p + 1] || ref.rgba[p + 2] !== dec.rgba[p + 2])) {
      visiblyExact = false;
    }
  }
  r.webpLossless = webp.length;
  r.webpVisiblyExact = visiblyExact;
}

function recommendation(r: FileResult): string {
  if (r.rel.startsWith("room/room")) return "scene background at the zlib floor — lazy-load per theme (only the active theme's 3 scenes are needed)";
  if (r.rel.startsWith("room/")) return "only loaded by /room — ship with the room bundle, not the core UI";
  if (r.rel.startsWith("lisa/")) return "already fetched on demand by slug — serve .webp when Accept allows, or make the mood pack an optional download";
  if (r.rel === "lisa-mascot.png") return "1024² but rendered ≤ 96 px + favicon — a 256² variant for the UI would cut it > 90% (reference change)";
  if (r.rel === "background-tile.png") return "not referenced by any CSS, only by the SW precache list — candidate for removal (reference change)";
  return "convert to WebP lossless once the reference can change";
}

// ─── reporting helpers ──────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
function pct(before: number, after: number): string {
  if (before === 0) return "0.0%";
  const d = ((after - before) / before) * 100;
  return `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toFixed(1)}%`;
}
function table(header: string[], align: Array<"l" | "r">, rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const sep = align.map((a) => (a === "r" ? "---:" : "---"));
  return [line(header), line(sep), ...rows.map(line)].join("\n");
}

async function walkPngs(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkPngs(path.join(dir, e.name), r)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".png")) out.push(r);
  }
  return out.sort();
}

async function otherPayload(dir: string, rel = ""): Promise<Map<string, { files: number; bytes: number }>> {
  const acc = new Map<string, { files: number; bytes: number }>();
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      for (const [k, v] of await otherPayload(path.join(dir, e.name), r)) acc.set(k, v);
    } else if (e.isFile() && !e.name.toLowerCase().endsWith(".png")) {
      const key = rel ? `${rel}/` : "(root)";
      const cur = acc.get(key) ?? { files: 0, bytes: 0 };
      cur.files++;
      cur.bytes += (await fs.stat(path.join(dir, e.name))).size;
      acc.set(key, cur);
    }
  }
  return acc;
}

async function pool<T, R>(items: T[], jobs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  if (args.icons) await deriveIcons(args.dryRun);

  let files = await walkPngs(ASSETS_DIR);
  if (args.filter) files = files.filter((f) => f.includes(args.filter!));
  console.log(`${args.dryRun ? "dry-run: " : ""}optimising ${files.length} PNG(s) under ${path.relative(process.cwd(), ASSETS_DIR)} (jobs=${args.jobs})`);

  let failures = 0;
  const results = await pool(files, args.jobs, async (rel) => {
    try {
      const r = await optimiseFile(rel, args.dryRun);
      if (r.skipped) console.log(`  - ${rel} skipped: ${r.skipped}`);
      else if (r.after < r.before) {
        console.log(`  ${args.dryRun ? "~" : "✓"} ${rel} ${fmtInt(r.before)} → ${fmtInt(r.after)} B (${pct(r.before, r.after)}, ${r.method})`);
      } else {
        console.log(`  · ${rel} ${fmtInt(r.before)} B already optimal (best exact candidate ${pct(r.before, r.bestCandidate)})`);
      }
      return r;
    } catch (err) {
      failures++;
      console.error(`  ✗ ${rel}: ${(err as Error).message}`);
      return undefined;
    }
  });
  const ok = results.filter((r): r is FileResult => r !== undefined);

  // Per-directory table.
  const dirs = new Map<string, FileResult[]>();
  for (const r of ok) (dirs.get(r.dir) ?? dirs.set(r.dir, []).get(r.dir)!).push(r);
  const rows: string[][] = [];
  const sum = (rs: FileResult[], k: "before" | "after") => rs.reduce((a, r) => a + r[k], 0);
  for (const [dir, rs] of [...dirs].sort((a, b) => sum(b[1], "before") - sum(a[1], "before"))) {
    rows.push([dir, String(rs.length), fmtBytes(sum(rs, "before")), fmtBytes(sum(rs, "after")), pct(sum(rs, "before"), sum(rs, "after"))]);
  }
  const before = sum(ok, "before");
  const after = sum(ok, "after");
  rows.push(["**total PNG**", String(ok.length), fmtBytes(before), fmtBytes(after), pct(before, after)]);
  const assertions = ok.reduce((a, r) => a + r.assertions, 0);
  const changed = ok.filter((r) => r.after < r.before).length;
  const skipped = ok.filter((r) => r.skipped).length;

  console.log(`\n## PNG size by directory${args.dryRun ? " (dry-run)" : ""}\n`);
  console.log(table(["directory", "files", "before", "after", "saved"], ["l", "r", "r", "r", "r"], rows));
  console.log(
    `\n${changed} file(s) reduced, ${ok.length - changed - skipped} already optimal, ${skipped} skipped, ${failures} failed; ` +
      `${fmtBytes(before - after)} saved; ${assertions} pixel-identical assertions passed; ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  const other = await otherPayload(ASSETS_DIR);
  if (other.size) {
    const otherRows = [...other].map(([dir, v]) => [dir, String(v.files), fmtBytes(v.bytes)]);
    const otherTotal = [...other.values()].reduce((a, v) => a + v.bytes, 0);
    console.log(`\nNon-PNG payload under assets (untouched, ${fmtBytes(otherTotal)}):\n`);
    console.log(table(["directory", "files", "bytes"], ["l", "r", "r"], otherRows));
  }

  // Estimate table: what a lossy-in-transparent-pixels WebP or a reference change would buy.
  const totalPayload = after + [...other.values()].reduce((a, v) => a + v.bytes, 0);
  if (args.estimate || totalPayload > TARGET_BYTES) {
    console.log(`\n## Still ${fmtBytes(totalPayload)} of assets (target < ${fmtBytes(TARGET_BYTES)}) — what lossless PNG cannot do\n`);
    await pool(ok, args.jobs, estimateWebp);
    const largest = [...ok].sort((a, b) => b.after - a.after).slice(0, args.top);
    const estRows = largest.map((r) => [
      r.rel,
      fmtBytes(r.after),
      `${r.width}×${r.height}${r.hasAlpha ? " RGBA" : " RGB"}, ${fmtInt(r.colours)} colours`,
      r.webpLossless !== undefined ? `${fmtBytes(r.webpLossless)} (${pct(r.after, r.webpLossless)})${r.webpVisiblyExact ? "" : " ⚠ visible diff"}` : "—",
      recommendation(r),
    ]);
    console.log(table(["file", "PNG now", "pixels", "WebP lossless", "recommendation"], ["l", "r", "l", "r", "l"], estRows));
    const webpTotal = ok.reduce((a, r) => a + (r.webpLossless ?? r.after), 0);
    const notVisiblyExact = ok.filter((r) => r.webpVisiblyExact === false).length;

    // Per-directory roll-up: the top-N table says which single files are big,
    // this says which *bundle* to make optional — that is the decision that
    // actually closes the gap to the target, not any one file.
    const otherBytes = [...other.values()].reduce((a, v) => a + v.bytes, 0);
    const webpRows: string[][] = [];
    for (const [dir, rs] of [...dirs].sort((a, b) => sum(b[1], "after") - sum(a[1], "after"))) {
      const w = rs.reduce((a, r) => a + (r.webpLossless ?? r.after), 0);
      webpRows.push([dir, String(rs.length), fmtBytes(sum(rs, "after")), fmtBytes(w), pct(sum(rs, "after"), w)]);
    }
    for (const [dir, v] of [...other].sort((a, b) => b[1].bytes - a[1].bytes)) {
      webpRows.push([`${dir} (non-PNG)`, String(v.files), fmtBytes(v.bytes), fmtBytes(v.bytes), "—"]);
    }
    webpRows.push(["**assets total**", String(ok.length + [...other.values()].reduce((a, v) => a + v.files, 0)),
      fmtBytes(after + otherBytes), fmtBytes(webpTotal + otherBytes), pct(after + otherBytes, webpTotal + otherBytes)]);
    console.log(`\nBundle roll-up — what each directory costs today and as lossless WebP:\n`);
    console.log(table(["bundle", "files", "now", "WebP lossless", "delta"], ["l", "r", "r", "r", "r"], webpRows));
    if (webpTotal + otherBytes > TARGET_BYTES) {
      console.log(
        `\nEven all-WebP leaves ${fmtBytes(webpTotal + otherBytes)} — still over the ${fmtBytes(TARGET_BYTES)} target, ` +
          `so format alone cannot get there: at least one bundle above has to stop shipping inside the npm tarball.`,
      );
    }

    console.log(
      `\nWebP lossless for all ${ok.length} PNGs: ${fmtBytes(webpTotal)} (${pct(after, webpTotal)} vs optimised PNG). ` +
        `libwebp keeps alpha and every visible pixel exact but rewrites RGB under alpha = 0 ` +
        `(${ok.filter((r) => r.hasAlpha).length} RGBA files are therefore not byte-exact; ${notVisiblyExact} differ in visible pixels). ` +
        `Converting requires the .png references in src/web/*.ts to change — not done here.`,
    );

    const groups = (key: (r: FileResult) => string) => {
      const m = new Map<string, string[]>();
      for (const r of ok) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r.rel);
      return [...m.values()].filter((g) => g.length > 1);
    };
    const byPixels = groups((r) => `${r.width}x${r.height}:${r.pixelHash}`);
    const byFile = groups((r) => r.fileHash);
    console.log(`\nDuplicate frames: ${byPixels.length === 0 ? "none — no two PNGs decode to the same pixels" : byPixels.map((g) => g.join(" = ")).join("; ")}` +
      `${byFile.length ? ` (byte-identical files: ${byFile.map((g) => g.join(" = ")).join("; ")})` : ""}`);
  }

  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).stack ?? (err as Error).message}`);
  process.exit(1);
});
