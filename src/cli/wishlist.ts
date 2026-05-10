/**
 * `lisa wishlist` — Sprint 4 instrumentation (§1.5 of SPRINT_4_PLAN.md).
 *
 * Surfaces Lisa's own meta-feedback about her toolset / architecture:
 *   1. Body of her `meta-wishlist` desire, if she's filled one in.
 *   2. Its progress.md (each weekly_examen Q4 nudge can append).
 *   3. Any journal lines tagged [WISHLIST] or [I want].
 *
 * Read at sprint-planning time to weight what's worth building next.
 * She is the most accurate signal source for what she needs.
 *
 * Lives in its own module so smoke tests (and any future tooling) can
 * invoke the handler without bootstrapping the rest of the CLI.
 */
import path from "node:path";
import { SOUL_DESIRES_DIR, SOUL_JOURNAL_DIR } from "../soul/paths.js";
import {
  listDesires,
  listJournalDates,
  parseDesireProgress,
  readJournal,
} from "../soul/store.js";

export const META_WISHLIST_SLUG = "meta-wishlist";
const JOURNAL_PATTERN = /\[WISHLIST\]|\[I want\b/i;

export interface WishlistRenderOptions {
  /** Override the writer for tests; default is console.log. */
  write?: (line: string) => void;
}

export async function renderWishlist(opts: WishlistRenderOptions = {}): Promise<void> {
  const write = opts.write ?? ((s: string) => console.log(s));
  let printed = false;

  // 1. The desire body, if it exists.
  const desires = await listDesires();
  const wishlist = desires.find((d) => d.slug === META_WISHLIST_SLUG);
  if (wishlist) {
    write(`── meta-wishlist desire ──\n`);
    write(`what: ${wishlist.what}`);
    write(`why:  ${wishlist.why}`);
    if (wishlist.actionable && wishlist.heartbeatPrompt) {
      write(`heartbeat: ${wishlist.heartbeatPrompt}`);
    }
    write("");
    printed = true;
  }

  // 2. progress.md, if present.
  const parsed = await parseDesireProgress(META_WISHLIST_SLUG);
  if (parsed.entries.length > 0 || parsed.preamble) {
    write(`── meta-wishlist progress (${parsed.entries.length} entries) ──\n`);
    if (parsed.preamble) {
      write(`[condensed earlier]\n${parsed.preamble}\n`);
    }
    for (const e of parsed.entries) {
      write(`  [${e.ts}]`);
      for (const line of e.body.split("\n")) write(`    ${line}`);
      write("");
    }
    printed = true;
  }

  // 3. Journal lines tagged [WISHLIST] or [I want] anywhere.
  const dates = await listJournalDates();
  const hits: { date: string; line: string }[] = [];
  for (const date of dates) {
    const body = await readJournal(date);
    for (const line of body.split("\n")) {
      if (JOURNAL_PATTERN.test(line) && line.trim()) {
        hits.push({ date, line: line.trim() });
      }
    }
  }
  if (hits.length > 0) {
    write(`── [WISHLIST] / [I want] mentions in journal (${hits.length}) ──\n`);
    for (const h of hits) write(`  ${h.date}: ${h.line}`);
    write("");
    printed = true;
  }

  if (!printed) {
    write(
      `(empty)\n\n` +
      `Nothing yet. Lisa fills this when she notices the toolset itself is missing or redundant — she'll mention it during weekly_examen, or in any session when she catches herself wishing.\n\n` +
      `She uses: soul_patch(field="desire", slug="${META_WISHLIST_SLUG}", what="...", why="...", actionable=false)\n` +
      `Path: ${path.join(SOUL_DESIRES_DIR, META_WISHLIST_SLUG + ".md")}\n` +
      `Journal scan: anywhere in ${SOUL_JOURNAL_DIR} containing [WISHLIST] or [I want]`,
    );
  }
}
