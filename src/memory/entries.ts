/**
 * Structured view of MEMORY.md / USER.md for user-facing edit & delete
 * (memory sovereignty, W8). The files stay free-form Markdown — Lisa's memory
 * tool appends `- entry` bullets — so this module parses them into entries
 * without imposing a schema, and writes back only the block that changed.
 *
 * Entry ids are content-addressed: `<m|u>_<hash(store, kind, text, ordinal)>`
 * where `ordinal` counts earlier entries with the identical text (duplicates
 * stay distinguishable). Editing or deleting one entry never changes another
 * entry's id, and an id whose entry was changed concurrently simply stops
 * resolving — a natural optimistic-concurrency check (404, not a lost write).
 *
 * Every mutation runs under the same lock the memory tool takes
 * (store.ts withMemoryLock), writes atomically, respects the byte caps, and
 * leaves one content-free audit line.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { appendSovereigntyAudit } from "../sovereignty/audit.js";
import {
  memoryMaxBytes,
  memoryStoreFile,
  withMemoryLock,
  writeMemory,
  type MemoryStore,
} from "./store.js";

export type MemoryEntryKind = "bullet" | "heading" | "text";

export interface MemoryEntry {
  id: string;
  store: MemoryStore;
  kind: MemoryEntryKind;
  /** Entry text without its Markdown marker (`- ` / `## `). */
  text: string;
  /** 1-based line of the entry's first line in the file. */
  line: number;
}

export interface ParsedMemoryStore {
  store: MemoryStore;
  entries: MemoryEntry[];
  bytes: number;
  maxBytes: number;
  /** True when the bytes are not clean UTF-8 text (NUL, invalid sequences). */
  corrupt: boolean;
  warnings: string[];
}

export type MemoryEditErrorCode =
  | "invalid_entry"
  | "invalid_store"
  | "not_found"
  | "memory_full"
  | "memory_corrupt";

export class MemoryEditError extends Error {
  constructor(
    readonly code: MemoryEditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemoryEditError";
  }
}

export const MEMORY_STORES: readonly MemoryStore[] = ["memory", "user"];

export function isMemoryStore(v: unknown): v is MemoryStore {
  return v === "memory" || v === "user";
}

// ── parsing ──────────────────────────────────────────────────────────────

interface Block {
  kind: MemoryEntryKind | "blank";
  lines: string[];
  /** 0-based index of the block's first line. */
  start: number;
  text: string;
  /** Heading level (number of `#`), heading blocks only. */
  level?: number;
}

const BULLET = /^[-*+][ \t]+/;
const HEADING = /^(#{1,6})[ \t]+/;

function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = splitLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prev = blocks[blocks.length - 1];
    if (line.trim() === "") {
      blocks.push({ kind: "blank", lines: [line], start: i, text: "" });
      continue;
    }
    if (/^[ \t]/.test(line) && prev?.kind === "bullet") {
      prev.lines.push(line);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", lines: [line], start: i, text: "" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        lines: [line],
        start: i,
        text: line.slice(heading[0].length).trim(),
        level: heading[1]!.length,
      });
      continue;
    }
    blocks.push({ kind: "text", lines: [line], start: i, text: line.trim() });
  }
  for (const b of blocks) {
    if (b.kind !== "bullet") continue;
    const [first, ...rest] = b.lines;
    b.text = [first!.replace(BULLET, "").trimEnd(), ...rest.map((l) => l.trim())]
      .join("\n")
      .trim();
  }
  return blocks;
}

function entryId(store: MemoryStore, kind: MemoryEntryKind, text: string, ordinal: number): string {
  const h = crypto
    .createHash("sha256")
    .update(`${store}\0${kind}\0${text}\0${ordinal}`)
    .digest("hex")
    .slice(0, 16);
  return `${store === "memory" ? "m" : "u"}_${h}`;
}

interface IndexedEntry {
  entry: MemoryEntry;
  block: Block;
}

function indexEntries(store: MemoryStore, blocks: Block[]): IndexedEntry[] {
  const seen = new Map<string, number>();
  const out: IndexedEntry[] = [];
  for (const block of blocks) {
    if (block.kind === "blank") continue;
    const key = `${block.kind}\0${block.text}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    out.push({
      block,
      entry: {
        id: entryId(store, block.kind, block.text, ordinal),
        store,
        kind: block.kind,
        text: block.text,
        line: block.start + 1,
      },
    });
  }
  return out;
}

/** Parse a store's text into entries (pure; used by tests and forget). */
export function parseMemoryEntries(store: MemoryStore, content: string): MemoryEntry[] {
  return indexEntries(store, parseBlocks(content)).map((e) => e.entry);
}

interface RawStore {
  content: string;
  bytes: number;
  corrupt: boolean;
  warnings: string[];
}

async function readRaw(store: MemoryStore): Promise<RawStore> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(memoryStoreFile(store));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", bytes: 0, corrupt: false, warnings: [] };
    }
    throw e;
  }
  const content = buf.toString("utf8");
  const warnings: string[] = [];
  let corrupt = false;
  if (buf.includes(0)) {
    corrupt = true;
    warnings.push("file contains NUL bytes");
  }
  if (!Buffer.from(content, "utf8").equals(buf)) {
    corrupt = true;
    warnings.push("file is not valid UTF-8");
  }
  if (buf.length > memoryMaxBytes(store)) {
    warnings.push(`file is over its ${memoryMaxBytes(store)}-byte cap`);
  }
  return { content, bytes: buf.length, corrupt, warnings };
}

/** Read and parse one store of the ACTIVE home. Never throws on bad content. */
export async function readMemoryStore(store: MemoryStore): Promise<ParsedMemoryStore> {
  const raw = await readRaw(store);
  return {
    store,
    entries: parseMemoryEntries(store, raw.content),
    bytes: raw.bytes,
    maxBytes: memoryMaxBytes(store),
    corrupt: raw.corrupt,
    warnings: raw.warnings,
  };
}

export async function listMemoryEntries(): Promise<ParsedMemoryStore[]> {
  return Promise.all(MEMORY_STORES.map((s) => readMemoryStore(s)));
}

// ── mutation ─────────────────────────────────────────────────────────────

/** Normalise + validate user-supplied entry text. */
export function normalizeEntryText(raw: unknown, kind: MemoryEntryKind = "bullet"): string {
  if (typeof raw !== "string") throw new MemoryEditError("invalid_entry", "text must be a string");
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) throw new MemoryEditError("invalid_entry", "text must not be empty");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    throw new MemoryEditError("invalid_entry", "text contains control characters");
  }
  if (kind !== "bullet" && text.includes("\n")) {
    throw new MemoryEditError("invalid_entry", `${kind} entries must be a single line`);
  }
  return text;
}

function renderBlock(kind: MemoryEntryKind, text: string, level = 2): string[] {
  if (kind === "heading") return [`${"#".repeat(level)} ${text}`];
  if (kind === "text") return [text];
  const [first, ...rest] = text.split("\n");
  return [`- ${first}`, ...rest.map((l) => (l.trim() ? `  ${l.trim()}` : ""))].filter(
    (l, i, arr) => !(l === "" && arr[i - 1] === ""),
  );
}

function serialize(blocks: Block[]): string {
  return blocks.flatMap((b) => b.lines).join("\n");
}

async function writeStore(store: MemoryStore, content: string): Promise<void> {
  try {
    await writeMemory(store, content);
  } catch (e) {
    if (/exceeds \d+ bytes/.test((e as Error).message)) {
      throw new MemoryEditError(
        "memory_full",
        `${store} memory would exceed its ${memoryMaxBytes(store)}-byte cap`,
      );
    }
    throw e;
  }
}

async function loadForEdit(store: MemoryStore): Promise<Block[]> {
  const raw = await readRaw(store);
  if (raw.corrupt) {
    // Fail closed: rewriting a non-UTF-8 file would silently replace bytes.
    throw new MemoryEditError(
      "memory_corrupt",
      `${store} memory is not clean UTF-8 text; repair the file by hand first`,
    );
  }
  return parseBlocks(raw.content);
}

function storeOfId(id: string): MemoryStore {
  if (/^m_[0-9a-f]{16}$/.test(id)) return "memory";
  if (/^u_[0-9a-f]{16}$/.test(id)) return "user";
  throw new MemoryEditError("not_found", "unknown entry id");
}

function findEntry(store: MemoryStore, blocks: Block[], id: string): IndexedEntry {
  const hit = indexEntries(store, blocks).find((e) => e.entry.id === id);
  if (!hit) throw new MemoryEditError("not_found", "entry not found (it may have changed)");
  return hit;
}

function locate(store: MemoryStore, content: string, text: string, kind: MemoryEntryKind) {
  const all = parseMemoryEntries(store, content).filter((e) => e.kind === kind && e.text === text);
  return all[all.length - 1];
}

export async function appendMemoryEntry(store: MemoryStore, rawText: unknown): Promise<MemoryEntry> {
  if (!isMemoryStore(store)) throw new MemoryEditError("invalid_store", "unknown store");
  const text = normalizeEntryText(rawText, "bullet");
  return withMemoryLock(async () => {
    const blocks = await loadForEdit(store);
    const current = serialize(blocks);
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    const next = `${current}${sep}${renderBlock("bullet", text).join("\n")}`;
    await writeStore(store, next);
    const entry = locate(store, next, text, "bullet")!;
    await appendSovereigntyAudit({ action: "memory.append", store, id: entry.id });
    return entry;
  });
}

export async function replaceMemoryEntry(id: string, rawText: unknown): Promise<MemoryEntry> {
  const store = storeOfId(id);
  return withMemoryLock(async () => {
    const blocks = await loadForEdit(store);
    const { block } = findEntry(store, blocks, id);
    const kind = block.kind as MemoryEntryKind;
    const text = normalizeEntryText(rawText, kind);
    block.lines = renderBlock(kind, text, block.level);
    const next = serialize(blocks);
    await writeStore(store, next);
    const reparsed = indexEntries(store, parseBlocks(next));
    // The edited block keeps its position: find the entry that starts there.
    const entry =
      reparsed.find((e) => e.block.start === block.start)?.entry ??
      locate(store, next, text, kind)!;
    await appendSovereigntyAudit({ action: "memory.replace", store, id, newId: entry.id });
    return entry;
  });
}

export async function deleteMemoryEntry(id: string): Promise<void> {
  const store = storeOfId(id);
  await withMemoryLock(async () => {
    const blocks = await loadForEdit(store);
    const { block } = findEntry(store, blocks, id);
    const next = blocks.filter((b) => b !== block);
    await writeStore(store, serialize(next));
    await appendSovereigntyAudit({ action: "memory.delete", store, id });
  });
}

/**
 * Rewrite a store's entries through `fn` under the memory lock (used by
 * forget). `fn` returns the new text for an entry, `null` to drop it, or the
 * same text to keep it. Returns the number of entries changed or dropped.
 */
export async function rewriteMemoryEntries(
  store: MemoryStore,
  fn: (entry: MemoryEntry) => string | null,
): Promise<number> {
  return withMemoryLock(async () => {
    const blocks = await loadForEdit(store);
    let changed = 0;
    const kept: Block[] = [];
    const indexed = new Map(indexEntries(store, blocks).map((e) => [e.block, e.entry]));
    for (const block of blocks) {
      const entry = indexed.get(block);
      if (!entry) {
        kept.push(block);
        continue;
      }
      const next = fn(entry);
      if (next === null) {
        changed++;
        continue;
      }
      if (next !== entry.text) {
        changed++;
        const text = entry.kind === "bullet" ? next : next.replace(/\n/g, " ");
        block.lines = renderBlock(entry.kind, text, block.level);
      }
      kept.push(block);
    }
    if (changed > 0) await writeStore(store, serialize(kept));
    return changed;
  });
}
