/**
 * Optional yt-dlp bridge — subtitle-fallback layer 2 (fixed order: built-in
 * API → yt-dlp → metadata-only; handoff decision, don't reorder).
 *
 * yt-dlp is only used to DISCOVER metadata/subtitle URLs (--dump-single-json,
 * no download); the actual subtitle fetch still goes through the SSRF-guarded
 * fetch. Not installed / crashes / times out all collapse to null — the
 * pipeline degrades, it never fails because of this layer.
 */
import { execFile } from "node:child_process";

const YTDLP_TIMEOUT_MS = 45_000;
const MAX_JSON_BYTES = 30 * 1024 * 1024;

export function ytDlpDumpJson(url: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    execFile(
      "yt-dlp",
      ["--no-warnings", "--skip-download", "--no-playlist", "--dump-single-json", url],
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: MAX_JSON_BYTES },
      (err, stdout) => {
        if (err) return resolve(null); // ENOENT (not installed) included
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

interface SubtitleTrack {
  url?: string;
  ext?: string;
}

/**
 * Pick a subtitle URL out of a yt-dlp info dump: manual subs beat automatic
 * captions; prefer json3, then any track. Language order zh* > en* > rest
 * mirrors the project's primary audiences; any track beats none.
 */
export function pickSubtitleUrl(info: Record<string, unknown>): string | null {
  for (const field of ["subtitles", "automatic_captions"]) {
    const langs = info[field] as Record<string, SubtitleTrack[]> | undefined;
    if (!langs || typeof langs !== "object") continue;
    const keys = Object.keys(langs);
    if (keys.length === 0) continue;
    const ordered = [
      ...keys.filter((k) => k.startsWith("zh")),
      ...keys.filter((k) => k.startsWith("en")),
      ...keys,
    ];
    for (const lang of ordered) {
      const tracks = langs[lang];
      if (!Array.isArray(tracks) || tracks.length === 0) continue;
      const track = tracks.find((t) => t.ext === "json3") ?? tracks[0]!;
      if (track.url) return track.url;
    }
  }
  return null;
}
