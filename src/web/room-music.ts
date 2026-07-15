/**
 * Room gramophone — the playlist behind GET /api/room/music.
 *
 * Two sources, merged:
 *   1. BUNDLED tracks shipped under assets/room/music/ (described by a
 *      manifest.json — title/mood/license/attribution). Only CC0 / public-domain
 *      / CC-BY audio we may legally redistribute lives here.
 *   2. The user's own drop-ins: any *.mp3 in ~/.lisa/music/ — so her room can
 *      play YOUR music without us shipping anything (mood "mine").
 *
 * Tracks are addressed by an opaque `id`, never a raw path — the file route
 * resolves an id back to a path only via this list, so there's no path-traversal
 * surface even for user files.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";

export type MusicMood = "classical" | "light" | "classic" | "mine";

export interface MusicTrack {
  id: string;
  title: string;
  mood: MusicMood;
  license: string;
  attribution?: string;
  durationSec?: number;
  source: "bundled" | "user";
}

export interface ResolvedMusicTrack extends MusicTrack {
  /** Absolute path on disk — server-only, never serialized to the client. */
  filePath: string;
}

interface BundledManifestEntry {
  id: string;
  title: string;
  mood: MusicMood;
  file: string;
  license: string;
  attribution?: string;
  durationSec?: number;
}

export function userMusicDir(): string {
  return path.join(LISA_HOME, "music");
}

const MOODS: ReadonlySet<string> = new Set(["classical", "light", "classic", "mine"]);

/**
 * Merged, resolved playlist: bundled tracks (from manifest.json) followed by the
 * user's ~/.lisa/music/*.mp3. Best-effort — a missing manifest or music dir just
 * yields fewer tracks, never throws.
 */
export async function listRoomMusic(bundledDir: string): Promise<ResolvedMusicTrack[]> {
  const out: ResolvedMusicTrack[] = [];
  const bundledRoot = path.resolve(bundledDir);

  // 1) bundled
  try {
    const raw = await fs.readFile(path.join(bundledDir, "manifest.json"), "utf8");
    const entries = JSON.parse(raw) as BundledManifestEntry[];
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (!e || typeof e.id !== "string" || typeof e.file !== "string") continue;
        if (e.file.includes("..") || e.file.includes("/") || e.file.includes("\\")) continue;
        const fp = path.resolve(path.join(bundledDir, e.file));
        if (fp !== bundledRoot && !fp.startsWith(bundledRoot + path.sep)) continue;
        out.push({
          id: "b_" + e.id,
          title: e.title || e.id,
          mood: MOODS.has(e.mood) ? e.mood : "classic",
          license: e.license || "unknown",
          attribution: e.attribution,
          durationSec: e.durationSec,
          source: "bundled",
          filePath: fp,
        });
      }
    }
  } catch {
    /* no bundled music / manifest — fine */
  }

  // 2) user drop-ins
  try {
    const dir = userMusicDir();
    const files = (await fs.readdir(dir)).filter((f) => /\.mp3$/i.test(f)).sort();
    for (const f of files) {
      out.push({
        id: "u_" + Buffer.from(f, "utf8").toString("base64url"),
        title: f.replace(/\.mp3$/i, "").replace(/[_]+/g, " ").trim() || f,
        mood: "mine",
        license: "user-provided",
        source: "user",
        filePath: path.join(dir, f),
      });
    }
  } catch {
    /* no ~/.lisa/music — fine */
  }

  return out;
}

/** Client-facing shape: drops filePath, adds the stream URL keyed by id. */
export function toPublicTrack(t: ResolvedMusicTrack): MusicTrack & { url: string } {
  const { filePath: _filePath, ...pub } = t;
  return { ...pub, url: `/api/room/music/file/${encodeURIComponent(t.id)}` };
}
