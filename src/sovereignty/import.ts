/**
 * Import a Lisa export archive (memory sovereignty, W8). Skeleton —
 * implemented in a follow-up commit on this branch.
 */

export interface ImportOptions {
  into: string;
  replace?: boolean;
}

export interface ImportResult {
  files: number;
  bytes: number;
  backup: string | null;
}

export async function importLisa(_archive: Buffer, _opts: ImportOptions): Promise<ImportResult> {
  throw new Error("import: not implemented yet");
}
