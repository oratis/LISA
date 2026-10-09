/**
 * Export a Lisa as a gzip'd tar with a manifest (memory sovereignty, W8).
 * Skeleton — implemented in a follow-up commit on this branch.
 */

export const EXPORT_FORMAT = "lisa-export";
export const EXPORT_FORMAT_VERSION = 1;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  lisaVersion: string;
  created: string;
  includesSessions: boolean;
  files: ManifestFile[];
}

export interface ExportOptions {
  home: string;
  includeSessions?: boolean;
}

export async function exportLisa(_opts: ExportOptions): Promise<Buffer> {
  throw new Error("export: not implemented yet");
}
