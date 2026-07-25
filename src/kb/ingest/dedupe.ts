/**
 * Ingest dedupe ledger — kb/.ingested.json, a flat `urlHash → slug` map.
 *
 * Sources are immutable (decision D2), so "ingest the same URL twice" must not
 * silently pile up near-identical captures: the default is to return the
 * existing slug, and only `force:true` writes a fresh capture (which then
 * records `supersedes:` pointing at the one it replaces).
 *
 * The ledger is a cache, not a source of truth: every ingested source carries
 * its own `hash:` frontmatter, so a missing or corrupt ledger is rebuilt from
 * the sources dir. Writes happen inside the store's KB write path, so the file
 * lives next to the entries it indexes (and travels with KB backups).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, pathExists } from "../../fs-utils.js";
import { kbDir } from "../paths.js";
import { listFullEntries } from "../store.js";

export function ingestLedgerFile(): string {
  return path.join(kbDir(), ".ingested.json");
}

type Ledger = Record<string, string>;

async function rebuildFromSources(): Promise<Ledger> {
  const ledger: Ledger = {};
  for (const e of await listFullEntries("sources")) {
    const hash = e.extra?.hash;
    // listFullEntries is newest-first; first-write-wins means the NEWEST
    // capture of a URL owns its hash — matching the live ledger, which is
    // repointed to the fresh slug after every forced re-ingest.
    if (hash && !(hash in ledger)) ledger[hash] = e.slug;
  }
  return ledger;
}

export async function readLedger(): Promise<Ledger> {
  const file = ingestLedgerFile();
  if (await pathExists(file)) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const ledger: Ledger = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") ledger[k] = v;
        }
        return ledger;
      }
    } catch {
      // corrupt → fall through to rebuild
    }
  }
  const rebuilt = await rebuildFromSources();
  await atomicWrite(file, JSON.stringify(rebuilt, null, 2) + "\n");
  return rebuilt;
}

/** The slug previously ingested for this url-hash, if any. */
export async function lookupIngested(hash: string): Promise<string | null> {
  return (await readLedger())[hash] ?? null;
}

/** Record (or repoint, after a forced re-ingest) a hash → slug mapping. */
export async function recordIngested(hash: string, slug: string): Promise<void> {
  const ledger = await readLedger();
  ledger[hash] = slug;
  await atomicWrite(ingestLedgerFile(), JSON.stringify(ledger, null, 2) + "\n");
}
