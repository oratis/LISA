import path from "node:path";
import { LISA_HOME } from "../paths.js";
import { assertSafeSlug } from "./slug.js";

export const SOUL_DIR = path.join(LISA_HOME, "soul");

export const SOUL_SEED = path.join(SOUL_DIR, "seed.json");
export const SOUL_NAME = path.join(SOUL_DIR, "name.md");
export const SOUL_IDENTITY = path.join(SOUL_DIR, "identity.md");
export const SOUL_PURPOSE = path.join(SOUL_DIR, "purpose.md");
export const SOUL_CONSTITUTION = path.join(SOUL_DIR, "constitution.md");
export const SOUL_EMOTIONS = path.join(SOUL_DIR, "emotions.json");
export const SOUL_LOCK = path.join(SOUL_DIR, "soul.lock.json");

export const SOUL_VALUES_DIR = path.join(SOUL_DIR, "values");
export const SOUL_OPINIONS_DIR = path.join(SOUL_DIR, "opinions");
export const SOUL_DESIRES_DIR = path.join(SOUL_DIR, "desires");
export const SOUL_JOURNAL_DIR = path.join(SOUL_DIR, "journal");
export const SOUL_RELATIONSHIPS_DIR = path.join(SOUL_DIR, "relationships");

// Every slug-bearing path helper runs the slug through assertSafeSlug first.
// This is the single chokepoint for path-traversal defense: a slug like
// "../../../etc/x" or "a/b" throws here rather than escaping the soul dir.
export function valueFile(slug: string): string {
  return path.join(SOUL_VALUES_DIR, `${assertSafeSlug(slug)}.md`);
}
export function opinionFile(slug: string): string {
  return path.join(SOUL_OPINIONS_DIR, `${assertSafeSlug(slug)}.md`);
}
export function desireFile(slug: string): string {
  return path.join(SOUL_DESIRES_DIR, `${assertSafeSlug(slug)}.md`);
}
export function desireProgressFile(slug: string): string {
  return path.join(SOUL_DESIRES_DIR, `${assertSafeSlug(slug)}.progress.md`);
}
export function journalFile(date: string): string {
  // Journal keys are dates (YYYY-MM-DD), which assertSafeSlug accepts (no
  // separators/dots-leading), so this guards against a malformed date too.
  return path.join(SOUL_JOURNAL_DIR, `${assertSafeSlug(date)}.md`);
}
export function relationshipFile(userKey: string): string {
  return path.join(SOUL_RELATIONSHIPS_DIR, `${assertSafeSlug(userKey)}.md`);
}
