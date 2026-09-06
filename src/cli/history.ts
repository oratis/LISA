/**
 * Persistent REPL history — `~/.lisa/history`.
 *
 * readline keeps history in memory only, so every new `lisa` session started
 * from a blank slate. The file is stored oldest-first (append-friendly, easy to
 * read), one entry per line; readline wants newest-first, so the caller
 * reverses at the boundary. Prompts routinely contain pasted secrets and
 * personal context, hence 0600 and a per-file cap rather than unbounded growth.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../paths.js";

export const HISTORY_LIMIT = 1000;

export function historyPath(): string {
  return path.join(lisaHome(), "history");
}

/**
 * Blank lines dropped, consecutive duplicates collapsed (hitting ↑ and Enter
 * twice must not fill the file with copies), capped to the newest `limit`
 * entries. Input and output are oldest-first.
 */
export function normalizeHistory(lines: readonly string[], limit = HISTORY_LIMIT): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** Oldest-first. A missing or unreadable file is an empty history, never an error. */
export async function loadHistory(file = historyPath(), limit = HISTORY_LIMIT): Promise<string[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return normalizeHistory(raw.split("\n"), limit);
  } catch {
    return [];
  }
}

/** Takes oldest-first lines. Atomic rename so a crash mid-write never truncates the file. */
export async function saveHistory(
  lines: readonly string[],
  file = historyPath(),
  limit = HISTORY_LIMIT,
): Promise<void> {
  const body = normalizeHistory(lines, limit);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // mode applies at creation, and the temp file is always new — so there is no
  // window in which the history is world-readable.
  await fs.writeFile(tmp, body.length > 0 ? body.join("\n") + "\n" : "", { mode: 0o600 });
  await fs.rename(tmp, file);
}
