/**
 * Layer 3 — the KB "schema": a rules doc (like Karpathy's CLAUDE.md) that tells
 * Lisa how the knowledge base is organized and the workflows to follow. Seeded
 * with a sane default on first use; both the user and Lisa may edit it. It is
 * injected always-on (see the prompt integration) so Lisa always knows the rules.
 */
import { atomicWrite, pathExists, readTextOrEmpty } from "../fs-utils.js";
import { KB_SCHEMA_FILE } from "./paths.js";

export const DEFAULT_SCHEMA = `# Knowledge base — schema & conventions

This is the user's personal knowledge base. It has three layers:

1. **Sources** (\`sources/\`) — raw, immutable captures: chat excerpts the user
   saved, pasted notes, documents. **Never edit or delete a source** — it is the
   user's own words, the source of truth. Read from it.
2. **Wiki** (\`wiki/\`) — the pages you maintain: concepts, entities, syntheses,
   overviews. **You own this layer.** Create and update pages from the sources
   AND from what you know about the user (your memory + journal). One idea per
   page; cross-link with \`[[slug]]\`; list the sources a page draws on in its
   \`sources:\` frontmatter.
3. This file (\`SCHEMA.md\`) — the rules. You and the user may edit it.

## Workflows

- **Answering from the KB.** The always-on \`index.md\` shows what exists. Reach
  for \`kb_search\` / \`kb_read\` when a question touches the user's own knowledge.
  Prefer the wiki for distilled answers; fall back to sources for specifics.
- **Ingesting a new source.** When new sources appear, fold their content into
  the relevant wiki page(s) with \`kb_write\` — create a page if none fits.
  Reconcile contradictions, don't just append; cite the source slugs.
- **Tending the wiki.** During reflection / idle time, review recent sources and
  your own memory + journal, and keep the wiki current, consistent, cross-linked.

## Conventions

- Titles are human-readable; slugs are lowercase-dashed and stable.
- Add a few \`tags:\` to every page for retrieval.
- Wiki pages are for the user to read — write clearly, lead with the gist.
- This KB is 100% local, under ~/.lisa/kb. Never send it anywhere.
`;

/** The schema text, or the built-in default if the user hasn't customized it. */
export async function readSchema(): Promise<string> {
  const text = await readTextOrEmpty(KB_SCHEMA_FILE);
  return text.trim() ? text : DEFAULT_SCHEMA;
}

/** Write the default schema if none exists yet. Idempotent. */
export async function ensureSchema(): Promise<void> {
  if (!(await pathExists(KB_SCHEMA_FILE))) {
    await atomicWrite(KB_SCHEMA_FILE, DEFAULT_SCHEMA);
  }
}

/** Replace the schema (user or Lisa editing the rules). */
export async function writeSchema(content: string): Promise<void> {
  await atomicWrite(KB_SCHEMA_FILE, content.trimEnd() + "\n");
}
