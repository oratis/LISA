/**
 * Streaming readers for session JSONL (T-5).
 *
 * A session file is append-only and unbounded: a long-running conversation
 * reaches tens of megabytes. Every consumer used to do
 * `(await readFile(f, "utf8")).split("\n")`, which allocates the whole file as
 * one string AND an array of every line — two large allocations that survive
 * into old space and trip a major GC. The v0.24 review measured 5–12 s
 * event-loop stalls on exactly that shape, on the request path.
 *
 * Reading the same bytes through a stream is the same I/O with O(one line) of
 * live memory, so the collector never sees a multi-megabyte string. Where the
 * answer lives at the end of the file (the newest reflection) a bounded tail
 * read avoids the I/O too.
 *
 * These helpers deliberately do not JSON.parse: callers know their own entry
 * shapes, and a corrupt line must stay skippable per-caller.
 */
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import { createInterface } from "node:readline";

/** Bytes read from the end of a file by `tailLines`. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * Yield the non-empty lines of `file` in order, holding one line at a time.
 * Throws the same errors `readFile` would (ENOENT and friends).
 */
export async function* jsonlLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line) yield line;
    }
  } finally {
    // Both, and in this order: closing the interface alone can leave the fd
    // open when the consumer breaks out early (a `for await` that returns).
    rl.close();
    stream.destroy();
  }
}

/**
 * The last `maxBytes` of `file` as whole lines, oldest first.
 *
 * A partial first line is dropped when the read did not start at byte 0 — it
 * may be truncated mid-record. `complete` says whether the tail covers the
 * entire file, so a caller that found nothing can decide whether a full scan
 * could still find something.
 */
export async function tailLines(
  file: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): Promise<{ lines: string[]; complete: boolean }> {
  const st = await fsp.stat(file);
  if (!st.isFile() || st.size === 0) return { lines: [], complete: true };
  const length = Math.min(maxBytes, st.size);
  const fd = await fsp.open(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, st.size - length);
    text = buf.toString("utf8");
  } finally {
    await fd.close();
  }
  const lines = text.split("\n").filter(Boolean);
  const complete = length === st.size;
  if (!complete && lines.length > 0) lines.shift();
  return { lines, complete };
}
