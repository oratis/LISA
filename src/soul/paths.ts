import path from "node:path";
import { lisaHome } from "../paths.js";
import { assertSafeSlug } from "./slug.js";

// Soul paths are FUNCTIONS of the active home (see ../paths.ts): under the
// cloud edition's per-uid request scope they resolve into that user's subtree.

export function soulDir(): string {
  return path.join(lisaHome(), "soul");
}

export function soulSeedFile(): string {
  return path.join(soulDir(), "seed.json");
}
export function soulNameFile(): string {
  return path.join(soulDir(), "name.md");
}
export function soulIdentityFile(): string {
  return path.join(soulDir(), "identity.md");
}
export function soulPurposeFile(): string {
  return path.join(soulDir(), "purpose.md");
}
export function soulConstitutionFile(): string {
  return path.join(soulDir(), "constitution.md");
}
export function soulEmotionsFile(): string {
  return path.join(soulDir(), "emotions.json");
}
export function soulLockFile(): string {
  return path.join(soulDir(), "soul.lock.json");
}

export function soulValuesDir(): string {
  return path.join(soulDir(), "values");
}
export function soulOpinionsDir(): string {
  return path.join(soulDir(), "opinions");
}
export function soulDesiresDir(): string {
  return path.join(soulDir(), "desires");
}
export function soulJournalDir(): string {
  return path.join(soulDir(), "journal");
}
export function soulRelationshipsDir(): string {
  return path.join(soulDir(), "relationships");
}

// Every slug-bearing path helper runs the slug through assertSafeSlug first.
// This is the single chokepoint for path-traversal defense: a slug like
// "../../../etc/x" or "a/b" throws here rather than escaping the soul dir.
export function valueFile(slug: string): string {
  return path.join(soulValuesDir(), `${assertSafeSlug(slug)}.md`);
}
export function opinionFile(slug: string): string {
  return path.join(soulOpinionsDir(), `${assertSafeSlug(slug)}.md`);
}
export function desireFile(slug: string): string {
  return path.join(soulDesiresDir(), `${assertSafeSlug(slug)}.md`);
}
export function desireProgressFile(slug: string): string {
  return path.join(soulDesiresDir(), `${assertSafeSlug(slug)}.progress.md`);
}
export function journalFile(date: string): string {
  // Journal keys are dates (YYYY-MM-DD), which assertSafeSlug accepts (no
  // separators/dots-leading), so this guards against a malformed date too.
  return path.join(soulJournalDir(), `${assertSafeSlug(date)}.md`);
}
export function relationshipFile(userKey: string): string {
  return path.join(soulRelationshipsDir(), `${assertSafeSlug(userKey)}.md`);
}
