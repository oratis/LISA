/**
 * Cross-layer "forget" (memory sovereignty, W8). Skeleton — implemented in a
 * follow-up commit on this branch.
 */

export type ForgetLayer =
  | "memory"
  | "user"
  | "kb"
  | "memory_kb_links"
  | "sessions"
  | "search_index"
  | "relationships"
  | "journal";

export interface ForgetLocation {
  layer: ForgetLayer;
  /** Home-relative path (or `memory:<id>` for an entry). Never content. */
  location: string;
  matches: number;
}

export interface ForgetReport {
  dryRun: boolean;
  counts: Record<ForgetLayer, number>;
  locations: ForgetLocation[];
  /** Things that cannot be erased from here, stated honestly. */
  residuals: string[];
}

export interface ForgetOptions {
  dryRun?: boolean;
}

export async function forget(_query: string, _opts: ForgetOptions = {}): Promise<ForgetReport> {
  throw new Error("forget: not implemented yet");
}
