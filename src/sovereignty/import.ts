/**
 * Import a Lisa export archive (memory sovereignty, W8).
 *
 * Fail-closed pipeline:
 *  1. bound the compressed size, then stream-decompress through the strict
 *     tar reader (links / devices / FIFOs refused, per-file + total + entry
 *     caps enforced as bytes arrive — a gzip bomb stops early);
 *  2. every path must be structurally safe (no absolute, `..`, backslash,
 *     control chars) AND something an honest export could contain — a planted
 *     `warden/…`, `config.env`, `.git/hooks/…` or lock rejects the archive;
 *  3. entries land in a private staging dir inside the target home; the
 *     manifest must list exactly the files present with matching sizes and
 *     sha256 before anything goes live;
 *  4. an existing soul (or any other non-empty area the archive carries) is
 *     never overwritten unless `replace` — and then the current areas are
 *     moved into `<home>/import-backups/<stamp>/` first, with rollback if the
 *     swap fails half-way;
 *  5. imported tasks arrive disabled (paused, "imported"), re-owned for the
 *     target home, so nothing starts acting on a new host by itself.
 *
 * Only the export areas are touched: config.env, accounts, warden/ and every
 * other piece of the target home's infrastructure stay as they are.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { lisaGlobalHome } from "../paths.js";
import { appendSovereigntyAudit } from "./audit.js";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "./export.js";
import { archivePathProblem, EXPORT_ROOTS, exclusionReason, MANIFEST_PATH } from "./layout.js";
import { readTar, TarFormatError, type TarEntryHeader } from "./tar.js";

export interface ImportLimits {
  maxArchiveBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxArchiveBytes: 1024 * 1024 * 1024, // 1 GiB compressed
  maxFileBytes: 256 * 1024 * 1024, // 256 MiB per file
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // 2 GiB uncompressed
  maxEntries: 200_000,
};

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

export type ImportErrorCode =
  | "archive_too_large"
  | "invalid_archive"
  | "bad_path"
  | "forbidden_entry"
  | "manifest_missing"
  | "manifest_invalid"
  | "hash_mismatch"
  | "soul_exists"
  | "target_exists"
  | "swap_failed";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportOptions {
  /** Target home. Defaults to the process home. */
  into?: string;
  replace?: boolean;
  limits?: Partial<ImportLimits>;
  now?: Date;
}

export interface ImportResult {
  into: string;
  files: number;
  bytes: number;
  roots: string[];
  backup: string | null;
  tasksDisabled: number;
  lisaVersion: string;
  created: string;
}

interface Written {
  size: number;
  sha256: string;
}

interface ManifestShape {
  format: string;
  formatVersion: number;
  lisaVersion?: unknown;
  created?: unknown;
  includesSessions?: unknown;
  files: { path: string; size: number; sha256: string }[];
}

function within(base: string, p: string): boolean {
  const rel = path.relative(base, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function rejectPath(p: string): void {
  const problem = archivePathProblem(p);
  if (problem) throw new ImportError("bad_path", `${problem}: ${JSON.stringify(p.slice(0, 200))}`);
  if (p === MANIFEST_PATH) return;
  const excluded = exclusionReason(p);
  if (excluded) {
    throw new ImportError(
      "forbidden_entry",
      `archive carries something an export never contains (${excluded}): ${JSON.stringify(p.slice(0, 200))}`,
    );
  }
}

/** Stream the archive into `staging`, validating every entry. */
async function unpackToStaging(
  archive: string,
  staging: string,
  limits: ImportLimits,
): Promise<{ written: Map<string, Written>; manifest: Buffer | null }> {
  const written = new Map<string, Written>();
  let manifest: Buffer | null = null;
  let manifestParts: Buffer[] | null = null;
  let receiving: "none" | "manifest" | "file" = "none";
  let cur: { rel: string; fh: fsp.FileHandle; hash: crypto.Hash; size: number } | null = null;

  const sink = {
    async begin(h: TarEntryHeader) {
      rejectPath(h.path);
      receiving = "none";
      if (h.type === "directory") {
        if (h.path === MANIFEST_PATH)
          throw new ImportError("bad_path", "manifest.json is a directory");
        const abs = path.join(staging, h.path);
        if (!within(staging, abs)) throw new ImportError("bad_path", "path escapes the target");
        await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
        return;
      }
      if (written.has(h.path) || (h.path === MANIFEST_PATH && manifestParts)) {
        throw new ImportError("invalid_archive", `duplicate entry: ${h.path}`);
      }
      if (h.path === MANIFEST_PATH) {
        if (h.size > MAX_MANIFEST_BYTES)
          throw new ImportError("manifest_invalid", "manifest too large");
        manifestParts = [];
        receiving = "manifest";
        return;
      }
      const abs = path.join(staging, h.path);
      if (!within(staging, abs)) throw new ImportError("bad_path", "path escapes the target");
      await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      // "wx": never write through anything that already exists in staging.
      const fh = await fsp.open(abs, "wx", 0o600);
      cur = { rel: h.path, fh, hash: crypto.createHash("sha256"), size: 0 };
      receiving = "file";
    },
    async data(chunk: Buffer) {
      if (receiving === "manifest") {
        manifestParts!.push(Buffer.from(chunk));
      } else if (receiving === "file" && cur) {
        cur.hash.update(chunk);
        cur.size += chunk.length;
        await cur.fh.write(chunk);
      }
    },
    async end() {
      if (receiving === "file" && cur) {
        const c = cur;
        cur = null;
        await c.fh.close();
        written.set(c.rel, { size: c.size, sha256: c.hash.digest("hex") });
      } else if (receiving === "manifest") {
        manifest = Buffer.concat(manifestParts!);
      }
      receiving = "none";
    },
  };

  const source = fs.createReadStream(archive).pipe(zlib.createGunzip());
  try {
    await readTar(source, sink, limits);
  } catch (e) {
    source.destroy();
    if (e instanceof ImportError) throw e;
    if (e instanceof TarFormatError) throw new ImportError("invalid_archive", e.message);
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (
      code.startsWith("Z_") ||
      /incorrect header check|unexpected end/i.test((e as Error).message)
    ) {
      throw new ImportError("invalid_archive", "not a valid gzip archive");
    }
    throw e;
  } finally {
    const open = cur as { fh: fsp.FileHandle } | null;
    if (open) await open.fh.close().catch(() => {});
  }
  return { written, manifest };
}

function parseManifest(raw: Buffer | null): ManifestShape {
  if (!raw) throw new ImportError("manifest_missing", "archive has no manifest.json");
  let m: unknown;
  try {
    m = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ImportError("manifest_invalid", "manifest.json is not valid JSON");
  }
  const o = m as Partial<ManifestShape> | null;
  if (!o || typeof o !== "object" || o.format !== EXPORT_FORMAT) {
    throw new ImportError("manifest_invalid", "not a Lisa export manifest");
  }
  if (
    typeof o.formatVersion !== "number" ||
    !Number.isInteger(o.formatVersion) ||
    o.formatVersion < 1 ||
    o.formatVersion > EXPORT_FORMAT_VERSION
  ) {
    throw new ImportError(
      "manifest_invalid",
      `unsupported export format version ${String(o.formatVersion)}`,
    );
  }
  if (!Array.isArray(o.files))
    throw new ImportError("manifest_invalid", "manifest has no file list");
  for (const f of o.files as unknown[]) {
    const e = f as { path?: unknown; size?: unknown; sha256?: unknown };
    if (
      !e ||
      typeof e.path !== "string" ||
      typeof e.size !== "number" ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      typeof e.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(e.sha256)
    ) {
      throw new ImportError("manifest_invalid", "malformed manifest file entry");
    }
    rejectPath(e.path);
    if (e.path === MANIFEST_PATH)
      throw new ImportError("manifest_invalid", "manifest lists itself");
  }
  return o as ManifestShape;
}

function verify(manifest: ManifestShape, written: Map<string, Written>): void {
  const listed = new Map<string, { size: number; sha256: string }>();
  for (const f of manifest.files) {
    if (listed.has(f.path))
      throw new ImportError("manifest_invalid", `duplicate manifest entry: ${f.path}`);
    listed.set(f.path, f);
  }
  for (const [p, w] of written) {
    const want = listed.get(p);
    if (!want) throw new ImportError("hash_mismatch", `file not in manifest: ${p}`);
    if (want.size !== w.size || want.sha256 !== w.sha256) {
      throw new ImportError("hash_mismatch", `size/sha256 mismatch: ${p}`);
    }
  }
  for (const p of listed.keys()) {
    if (!written.has(p))
      throw new ImportError("hash_mismatch", `manifest lists a missing file: ${p}`);
  }
  if (
    manifest.includesSessions !== true &&
    [...written.keys()].some((p) => p.startsWith("sessions/"))
  ) {
    throw new ImportError(
      "manifest_invalid",
      "sessions present but the manifest says they were not exported",
    );
  }
}

/** Does an area of the target home already hold data (ignoring locks/temp)? */
async function areaHasData(into: string, root: string): Promise<boolean> {
  if (root === "memory") {
    for (const f of ["MEMORY.md", "USER.md"]) {
      try {
        if ((await fsp.stat(path.join(into, "memory", f))).size > 0) return true;
      } catch {
        // missing
      }
    }
    return false;
  }
  let names: string[];
  try {
    names = await fsp.readdir(path.join(into, root));
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" ||
      (e as NodeJS.ErrnoException).code === "ENOTDIR"
    ) {
      return (e as NodeJS.ErrnoException).code === "ENOTDIR";
    }
    throw e;
  }
  return names.some((n) => !n.endsWith(".lock") && !n.endsWith(".tmp"));
}

/** Owner uid for tasks imported into `into` (a cloud tenant home) or null. */
function ownerFor(into: string): string | null {
  const users = path.join(lisaGlobalHome(), "users");
  const rel = path.relative(users, into);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep)
    ? rel
    : null;
}

const ACTIVE_TASK_STATES = new Set([
  "scheduled",
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_input",
]);

/** Imported tasks never start acting on a new host by themselves. */
async function disableImportedTasks(stagedTasks: string, owner: string | null): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(stagedTasks);
  } catch {
    return 0;
  }
  let disabled = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(stagedTasks, name);
    let spec: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      spec = parsed as Record<string, unknown>;
    } catch {
      continue; // left as-is; the task store treats an unreadable spec as corrupt
    }
    spec.enabled = false;
    spec.pausedReason = "imported";
    spec.owner = owner;
    if (typeof spec.state === "string" && ACTIVE_TASK_STATES.has(spec.state)) spec.state = "paused";
    delete spec.nextRunAt;
    await fsp.writeFile(file, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
    disabled++;
  }
  return disabled;
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

interface Move {
  from: string;
  to: string;
}

/**
 * Import `archive` into `opts.into`. Throws ImportError (with a stable code)
 * for anything wrong with the archive or a refused overwrite.
 */
export async function importLisa(archive: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...opts.limits };
  const into = path.resolve(opts.into ?? lisaGlobalHome());
  const now = opts.now ?? new Date();

  const st = await fsp.stat(archive);
  if (!st.isFile()) throw new ImportError("invalid_archive", "archive is not a regular file");
  if (st.size > limits.maxArchiveBytes) {
    throw new ImportError(
      "archive_too_large",
      `archive is larger than ${limits.maxArchiveBytes} bytes`,
    );
  }

  await fsp.mkdir(into, { recursive: true, mode: 0o700 });
  const staging = await fsp.mkdtemp(path.join(into, ".import-"));
  try {
    const { written, manifest: rawManifest } = await unpackToStaging(archive, staging, limits);
    const manifest = parseManifest(rawManifest);
    verify(manifest, written);

    const roots = EXPORT_ROOTS.filter((r) =>
      [...written.keys()].some((p) => p.startsWith(`${r}/`)),
    );
    for (const root of roots) {
      if (await areaHasData(into, root)) {
        if (opts.replace) continue;
        if (root === "soul") {
          throw new ImportError(
            "soul_exists",
            `${into} already has a soul — pass --replace to back it up and replace it`,
          );
        }
        throw new ImportError(
          "target_exists",
          `${into} already has ${root}/ data — pass --replace to back it up and replace it`,
        );
      }
    }

    const tasksDisabled = roots.includes("tasks")
      ? await disableImportedTasks(path.join(staging, "tasks"), ownerFor(into))
      : 0;

    // ── swap (rollback-able) ──
    const backupRoot = opts.replace ? path.join(into, "import-backups", stampOf(now)) : null;
    const trash = path.join(staging, ".replaced");
    const done: Move[] = [];
    const move = async (from: string, to: string): Promise<void> => {
      await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await fsp.rename(from, to);
      done.push({ from, to });
    };
    let backedUp = false;
    try {
      for (const root of roots) {
        if (root === "memory") {
          for (const f of ["MEMORY.md", "USER.md"]) {
            const staged = path.join(staging, "memory", f);
            if (!(await exists(staged))) continue;
            const target = path.join(into, "memory", f);
            if (await exists(target)) {
              await move(target, path.join(backupRoot ?? trash, "memory", f));
              backedUp ||= Boolean(backupRoot);
            }
            await move(staged, target);
          }
          continue;
        }
        const target = path.join(into, root);
        if (await exists(target)) {
          // Non-empty only reaches here with replace; an empty/lock-only dir
          // is moved aside into staging and discarded with it.
          const hasData = await areaHasData(into, root);
          await move(target, path.join(hasData && backupRoot ? backupRoot : trash, root));
          backedUp ||= hasData && Boolean(backupRoot);
        }
        await move(path.join(staging, root), target);
      }
    } catch (e) {
      for (const m of done.reverse()) {
        await fsp.rename(m.to, m.from).catch(() => {});
      }
      throw new ImportError(
        "swap_failed",
        `import could not be completed and was rolled back: ${(e as Error).message}`,
      );
    }

    const bytes = [...written.values()].reduce((n, w) => n + w.size, 0);
    await appendSovereigntyAudit(
      {
        action: "import",
        counts: { files: written.size, tasksDisabled },
        bytes,
        note: opts.replace ? "replace" : "fresh",
      },
      into,
    );
    return {
      into,
      files: written.size,
      bytes,
      roots,
      backup: backedUp ? backupRoot : null,
      tasksDisabled,
      lisaVersion: typeof manifest.lisaVersion === "string" ? manifest.lisaVersion : "unknown",
      created: typeof manifest.created === "string" ? manifest.created : "",
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
