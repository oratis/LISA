/**
 * Subtitle payload parsing + the shared "video entry" markdown shape.
 *
 * Core rule (handoff, in bold): A MISSING TRANSCRIPT IS NOT A FAILURE. Video
 * platforms break subtitle access routinely (login gates, PO tokens, empty
 * 200s, IP throttling) — the capture degrades to metadata + description with
 * `transcript: unavailable (<reason>)` recorded in frontmatter, and the tool
 * layer tells the user they can paste a transcript themselves. Ingest only
 * fails when even metadata is unreachable.
 */

/** YouTube timedtext `fmt=json3`: { events: [{ segs: [{ utf8 }] }] }. */
export function parseJson3(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      events?: { segs?: { utf8?: string }[] }[];
    };
    if (!parsed?.events) return null;
    const lines: string[] = [];
    for (const ev of parsed.events) {
      const text = (ev.segs ?? [])
        .map((s) => s.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text) lines.push(text);
    }
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

/** Bilibili subtitle JSON: { body: [{ content }] }. */
export function parseBilibiliSubtitle(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { body?: { content?: string }[] };
    if (!Array.isArray(parsed?.body)) return null;
    const lines = parsed.body
      .map((l) => (l.content ?? "").trim())
      .filter(Boolean);
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

/** Either known subtitle payload shape → plain text. */
export function parseSubtitlePayload(raw: string): string | null {
  return parseJson3(raw) ?? parseBilibiliSubtitle(raw);
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (!Number.isFinite(seconds) || seconds == null || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export interface VideoInfo {
  title: string;
  url: string;
  uploader?: string;
  duration?: number;
  category?: string;
  description?: string;
  /** Plain-text transcript, when a subtitle layer succeeded. */
  transcript?: string;
}

/** The uniform Layer-1 body for video captures across platforms. */
export function formatVideoBody(v: VideoInfo): string {
  const meta = [
    v.uploader ? `- 创作者: ${v.uploader}` : "",
    formatDuration(v.duration) ? `- 时长: ${formatDuration(v.duration)}` : "",
    v.category ? `- 分区: ${v.category}` : "",
    `- 链接: ${v.url}`,
  ].filter(Boolean);
  const sections = [meta.join("\n")];
  if (v.description?.trim()) sections.push(`## 简介\n\n${v.description.trim()}`);
  if (v.transcript?.trim()) sections.push(`## 字幕\n\n${v.transcript.trim()}`);
  return sections.join("\n\n");
}
