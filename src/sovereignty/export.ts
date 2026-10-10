/**
 * Export a Lisa as a gzip'd tar with a manifest (memory sovereignty, W8).
 *
 * Archive layout: home-relative paths (`soul/…`, `memory/MEMORY.md`, `kb/…`,
 * `skills/…`, `sessions/…` when opted in, `tasks/…`) followed by
 * `manifest.json` — format + version, LISA version, creation time, the
 * exclusion statement and every file's size + sha256. The manifest goes LAST
 * so each file is read exactly once (hash computed while streaming), which
 * keeps the export a consistent per-file snapshot even while sessions grow.
 *
 * Safety: the walk never follows a symlink (lstat + O_NOFOLLOW), skips
 * anything that is not a regular file, and applies layout.ts's allowlist +
 * exclusions, so secrets and infrastructure state are never read at all.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appendSovereigntyAudit } from "./audit.js";
import {
  archivePathProblem,
  EXPORT_EXCLUSIONS,
  EXPORT_ROOTS,
  exclusionReason,
  MANIFEST_PATH,
} from "./layout.js";
import { tarFileHeader, tarPadding, tarTrailer } from "./tar.js";

export const EXPORT_FORMAT = "lisa-export";
export const EXPORT_FORMAT_VERSION = 1;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  lisaVersion: string;
  created: string;
  includesSessions: boolean;
  roots: string[];
  excludes: readonly string[];
  files: ManifestFile[];
  /** Files present in the export areas but skipped (links, odd names…). */
  skipped: number;
}

export interface ExportOptions {
  /** The home to export. Callers pass the tenant home explicitly. */
  home: string;
  includeSessions?: boolean;
  /** Override for tests. */
  now?: Date;
}

let cachedVersion: string | null = null;
/** package.json version (dist/sovereignty and src/sovereignty are 2 deep). */
export function lisaPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8"),
    ) as {
      version?: string;
    };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

interface PlannedFile {
  rel: string;
  abs: string;
}

/**
 * List the files an export of `home` would carry, sorted. Never follows a
 * symlink and never descends into an excluded directory.
 */
export async function planExport(
  home: string,
  opts: { includeSessions?: boolean } = {},
): Promise<{ files: PlannedFile[]; skipped: number }> {
  const files: PlannedFile[] = [];
  let skipped = 0;
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const d of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = `${relDir}/${d.name}`;
      if (exclusionReason(rel) !== null) continue;
      if (archivePathProblem(rel) !== null) {
        skipped++;
        continue;
      }
      const abs = path.join(absDir, d.name);
      if (d.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (d.isDirectory()) await walk(abs, rel);
      else if (d.isFile()) files.push({ rel, abs });
      else skipped++;
    }
  };
  for (const root of EXPORT_ROOTS) {
    if (root === "sessions" && !opts.includeSessions) continue;
    const abs = path.join(home, root);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    if (!st.isDirectory()) {
      skipped++;
      continue;
    }
    await walk(abs, root);
  }
  return { files, skipped };
}

const READ_CHUNK = 64 * 1024;

/** Stream one file: header, exactly `size` bytes, padding. Hash as we go. */
async function* fileRecord(file: PlannedFile, out: ManifestFile[]): AsyncGenerator<Buffer> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(file.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return; // vanished / became a link
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return;
    const size = st.size;
    yield tarFileHeader(file.rel, size, st.mtimeMs);
    const hash = crypto.createHash("sha256");
    let read = 0;
    while (read < size) {
      const want = Math.min(READ_CHUNK, size - read);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, read);
      if (bytesRead === 0) throw new Error(`export: ${file.rel} shrank while being read`);
      const piece = buf.subarray(0, bytesRead);
      hash.update(piece);
      read += bytesRead;
      yield piece;
    }
    yield tarPadding(size);
    out.push({ path: file.rel, size, sha256: hash.digest("hex") });
  } finally {
    await fh.close();
  }
}

/**
 * Write an export of `opts.home` (gzip'd tar) to `out`. Resolves with the
 * manifest once the stream has been fully written.
 */
export async function writeExport(opts: ExportOptions, out: Writable): Promise<ExportManifest> {
  const includeSessions = Boolean(opts.includeSessions);
  const plan = await planExport(opts.home, { includeSessions });
  const manifestFiles: ManifestFile[] = [];
  let manifest: ExportManifest | null = null;
  async function* generate(): AsyncGenerator<Buffer> {
    for (const f of plan.files) yield* fileRecord(f, manifestFiles);
    manifest = {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      lisaVersion: lisaPackageVersion(),
      created: (opts.now ?? new Date()).toISOString(),
      includesSessions: includeSessions,
      roots: EXPORT_ROOTS.filter((r) => r !== "sessions" || includeSessions),
      excludes: EXPORT_EXCLUSIONS,
      files: manifestFiles,
      skipped: plan.skipped,
    };
    const body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    yield tarFileHeader(MANIFEST_PATH, body.length, Date.now());
    yield body;
    yield tarPadding(body.length);
    yield tarTrailer();
  }
  await pipeline(Readable.from(generate()), zlib.createGzip({ level: 6 }), out);
  const done = manifest as ExportManifest | null;
  if (!done) throw new Error("export: archive was not completed");
  await appendSovereigntyAudit(
    {
      action: "export",
      counts: { files: done.files.length, skipped: done.skipped },
      bytes: done.files.reduce((n, f) => n + f.size, 0),
      note: includeSessions ? "with sessions" : "without sessions",
    },
    opts.home,
  );
  return done;
}

/** Export to a file, written to a temp name and renamed into place (0600). */
export async function exportLisaToFile(opts: ExportOptions, file: string): Promise<ExportManifest> {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.partial`;
  const stream = fs.createWriteStream(tmp, { mode: 0o600, flags: "wx" });
  try {
    const manifest = await writeExport(opts, stream);
    await fsp.rename(tmp, file);
    return manifest;
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Suggested download name, e.g. `lisa-export-2026-10-09.tar.gz`. */
export function exportFileName(now: Date = new Date()): string {
  return `lisa-export-${now.toISOString().slice(0, 10)}.tar.gz`;
}
