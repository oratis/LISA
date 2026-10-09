/**
 * Minimal tar (POSIX ustar + pax `path`) writer and a strict streaming reader
 * for Lisa export archives. No dependency, no shell, no system `tar`.
 *
 * The writer emits regular files only. The reader is deliberately narrow: it
 * accepts regular files and directories, plus pax extended headers for long
 * paths, and rejects every other entry type (symlink, hardlink, character /
 * block device, FIFO, GNU long-name, sparse…) instead of skipping it — a
 * crafted archive fails closed. Header checksums are verified, base-256 sizes
 * are refused, and the caller bounds per-file and total sizes while the bytes
 * are still streaming (gzip-bomb safe).
 */

const BLOCK = 512;

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarFormatError";
  }
}

// ── writer ───────────────────────────────────────────────────────────────

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new TarFormatError(`tar field overflow (${length})`);
  bytes.copy(buf, offset);
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  // length-1 octal digits + NUL terminator.
  const digits = Math.floor(value).toString(8);
  if (digits.length > length - 1) throw new TarFormatError(`tar numeric overflow (${length})`);
  writeString(buf, offset, length, digits.padStart(length - 1, "0") + "\0");
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum;
}

/** Split a path into ustar (prefix, name), or null when it doesn't fit. */
function splitUstar(p: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(p) <= 100) return { prefix: "", name: p };
  for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) {
      return { prefix, name };
    }
  }
  return null;
}

function rawHeader(opts: {
  name: string;
  prefix?: string;
  size: number;
  mtime: number;
  mode: number;
  type: "0" | "5" | "x";
}): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  writeString(h, 0, 100, opts.name);
  writeOctal(h, 100, 8, opts.mode);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, opts.size);
  writeOctal(h, 136, 12, opts.mtime);
  h.fill(0x20, 148, 156);
  writeString(h, 156, 1, opts.type);
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  writeString(h, 345, 155, opts.prefix ?? "");
  const sum = checksum(h);
  writeString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  // The length prefix counts itself, so iterate until it is stable.
  let len = Buffer.byteLength(body) + 1;
  for (;;) {
    const next = Buffer.byteLength(body) + String(len).length;
    if (next === len) break;
    len = next;
  }
  return `${len}${body}`;
}

function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

/** Header block(s) for a regular file of `size` bytes at archive path `p`. */
export function tarFileHeader(p: string, size: number, mtimeMs: number): Buffer {
  const mtime = Math.max(0, Math.floor(mtimeMs / 1000));
  const split = splitUstar(p);
  if (split) {
    return rawHeader({ ...split, size, mtime, mode: 0o600, type: "0" });
  }
  const pax = Buffer.from(paxRecord("path", p), "utf8");
  const paxHeader = rawHeader({
    name: "PaxHeader/" + p.slice(-80).replace(/^\/+/, ""),
    size: pax.length,
    mtime,
    mode: 0o600,
    type: "x",
  });
  const shortName = p.split("/").pop()!.slice(-100);
  return Buffer.concat([
    paxHeader,
    pax,
    padding(pax.length),
    rawHeader({ name: shortName, size, mtime, mode: 0o600, type: "0" }),
  ]);
}

export function tarPadding(size: number): Buffer {
  return padding(size);
}

/** The end-of-archive marker: two zero blocks. */
export function tarTrailer(): Buffer {
  return Buffer.alloc(BLOCK * 2, 0);
}

// ── reader ───────────────────────────────────────────────────────────────

export type TarEntryType = "file" | "directory";

export interface TarEntryHeader {
  path: string;
  type: TarEntryType;
  size: number;
}

export interface TarReadLimits {
  /** Largest single file. */
  maxFileBytes: number;
  /** Sum of all file sizes. */
  maxTotalBytes: number;
  /** Number of entries (files + directories). */
  maxEntries: number;
}

export interface TarEntrySink {
  /** Called once per entry before its data; throw to reject the archive. */
  begin(header: TarEntryHeader): Promise<void> | void;
  data(chunk: Buffer): Promise<void> | void;
  end(): Promise<void> | void;
}

const TYPE_NAMES: Record<string, string> = {
  "1": "hard link",
  "2": "symbolic link",
  "3": "character device",
  "4": "block device",
  "6": "FIFO",
  "7": "contiguous file",
  L: "GNU long name",
  K: "GNU long link",
  S: "sparse file",
  V: "volume header",
  M: "multi-volume entry",
};

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, length: number, field: string): number {
  if (buf[offset]! & 0x80) throw new TarFormatError(`unsupported base-256 ${field}`);
  const s = readString(buf, offset, length).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarFormatError(`malformed ${field}`);
  const n = parseInt(s, 8);
  if (!Number.isSafeInteger(n)) throw new TarFormatError(`malformed ${field}`);
  return n;
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) throw new TarFormatError("malformed pax header");
    const len = parseInt(body.subarray(i, sp).toString("ascii"), 10);
    if (!Number.isSafeInteger(len) || len <= 0 || i + len > body.length) {
      throw new TarFormatError("malformed pax header");
    }
    const rec = body.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq <= 0) throw new TarFormatError("malformed pax record");
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

const MAX_PAX_BYTES = 64 * 1024;

/** What the bytes following the current header belong to. */
type Body = { kind: "data" } | { kind: "pax"; parts: Buffer[] } | { kind: "skip" };

/**
 * Stream-parse a (decompressed) tar from `source`, handing each entry to
 * `sink`. Enforces `limits` as bytes arrive. Resolves when the end marker (or
 * a clean EOF on a block boundary) is reached.
 */
export async function readTar(
  source: AsyncIterable<Buffer>,
  sink: TarEntrySink,
  limits: TarReadLimits,
): Promise<{ entries: number; bytes: number }> {
  let buf: Buffer = Buffer.alloc(0);
  let entries = 0;
  let total = 0;
  let consumed = 0;
  let pending: Record<string, string> | null = null;
  let body: Body | null = null; // non-null while inside an entry's data
  let remaining = 0; // body bytes still to read
  let pad = 0; // padding bytes to skip after the body
  let zeroBlocks = 0;
  let done = false;

  const finishBody = async (): Promise<void> => {
    const b = body!;
    body = null;
    if (b.kind === "pax") pending = parsePax(Buffer.concat(b.parts));
    else if (b.kind === "data") await sink.end();
  };

  const handleHeader = async (h: Buffer): Promise<void> => {
    if (h.every((x) => x === 0)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) done = true;
      return;
    }
    if (zeroBlocks > 0) throw new TarFormatError("data after end-of-archive marker");
    const stored = readOctal(h, 148, 8, "checksum");
    if (stored !== checksum(h)) throw new TarFormatError("tar header checksum mismatch");
    const typeflag = String.fromCharCode(h[156]!);
    const size = readOctal(h, 124, 12, "size");
    pad = (BLOCK - (size % BLOCK)) % BLOCK;
    remaining = size;
    if (typeflag === "x" || typeflag === "g") {
      if (size > MAX_PAX_BYTES) throw new TarFormatError("pax header too large");
      // A global header ("g") is framed and then ignored.
      body = typeflag === "x" ? { kind: "pax", parts: [] } : { kind: "skip" };
      if (remaining === 0) await finishBody();
      return;
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") {
      throw new TarFormatError(
        `refusing ${TYPE_NAMES[typeflag] ?? `entry type ${JSON.stringify(typeflag)}`}`,
      );
    }
    const magic = readString(h, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(h, 345, 155) : "";
    const name = readString(h, 0, 100);
    let p = pending?.path ?? (prefix ? `${prefix}/${name}` : name);
    pending = null;
    const type: TarEntryType = typeflag === "5" ? "directory" : "file";
    if (type === "directory") p = p.replace(/\/+$/, "");
    if (type === "directory" && size !== 0) throw new TarFormatError("directory with data");
    entries++;
    if (entries > limits.maxEntries) throw new TarFormatError("too many archive entries");
    if (size > limits.maxFileBytes) throw new TarFormatError(`file too large: ${size} bytes`);
    total += size;
    if (total > limits.maxTotalBytes) throw new TarFormatError("archive content too large");
    await sink.begin({ path: p, type, size });
    body = { kind: "data" };
    if (remaining === 0) await finishBody();
  };

  // Decompressed bytes may not exceed content plus generous header overhead.
  const maxConsumed = limits.maxTotalBytes + (limits.maxEntries + 4) * BLOCK * 4;

  for await (const chunk of source) {
    consumed += chunk.length;
    if (consumed > maxConsumed) throw new TarFormatError("archive content too large");
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (!done) {
      if (body && remaining > 0) {
        if (buf.length === 0) break;
        const take = Math.min(remaining, buf.length);
        const piece = buf.subarray(0, take);
        buf = buf.subarray(take);
        remaining -= take;
        const b: Body = body;
        if (b.kind === "pax") b.parts.push(Buffer.from(piece));
        else if (b.kind === "data") await sink.data(piece);
        if (remaining === 0) await finishBody();
        continue;
      }
      if (pad > 0) {
        if (buf.length === 0) break;
        const take = Math.min(pad, buf.length);
        buf = buf.subarray(take);
        pad -= take;
        continue;
      }
      if (buf.length < BLOCK) break;
      const header = buf.subarray(0, BLOCK);
      buf = buf.subarray(BLOCK);
      await handleHeader(header);
    }
    if (done) break;
  }
  if (body || remaining > 0 || pad > 0) throw new TarFormatError("truncated archive");
  if (!done && buf.length > 0) throw new TarFormatError("truncated archive");
  if (pending) throw new TarFormatError("dangling pax header");
  return { entries, bytes: total };
}
