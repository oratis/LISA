import path from "node:path";
import { LISA_HOME } from "../paths.js";

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

export function valueFile(slug: string): string {
  return path.join(SOUL_VALUES_DIR, `${slug}.md`);
}
export function opinionFile(slug: string): string {
  return path.join(SOUL_OPINIONS_DIR, `${slug}.md`);
}
export function desireFile(slug: string): string {
  return path.join(SOUL_DESIRES_DIR, `${slug}.md`);
}
export function desireProgressFile(slug: string): string {
  return path.join(SOUL_DESIRES_DIR, `${slug}.progress.md`);
}
export function journalFile(date: string): string {
  return path.join(SOUL_JOURNAL_DIR, `${date}.md`);
}
export function relationshipFile(userKey: string): string {
  return path.join(SOUL_RELATIONSHIPS_DIR, `${userKey}.md`);
}
