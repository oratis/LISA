/**
 * YouTube videos (youtube.com/watch, youtu.be, m.youtube.com, /shorts).
 *
 * Metadata: oEmbed (stable, unauthenticated) + the InnerTube player response
 * (title/description/captions in one POST). Captions go captionTracks →
 * `&fmt=json3`. This WILL fail in the wild — PO-token enforcement, `exp=xpe`
 * 200-with-empty-body responses, datacenter-IP throttling — so the fixed
 * layering applies: built-in API → yt-dlp (if installed) → metadata +
 * description. A missing transcript is a degradation, never a failure.
 */
import type { IngestAdapter, IngestContext, IngestedContent } from "../types.js";
import { formatVideoBody, parseJson3, parseSubtitlePayload } from "./subtitle.js";
import { pickSubtitleUrl, ytDlpDumpJson } from "./ytdlp.js";

export function videoIdOf(url: URL): string | null {
  if (url.hostname === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return id || null;
  }
  if (/(^|\.)youtube\.com$/.test(url.hostname)) {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const short = /^\/(?:shorts|embed|live)\/([\w-]{5,})/.exec(url.pathname);
    return short?.[1] ?? null;
  }
  return null;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerResponse {
  videoDetails?: {
    title?: string;
    author?: string;
    shortDescription?: string;
    lengthSeconds?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
}

async function innertubePlayer(id: string, ctx: IngestContext): Promise<PlayerResponse | null> {
  const res = await ctx.fetchImpl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      videoId: id,
      context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00" } },
    }),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null; // the documented 200-empty-body failure mode
  try {
    return JSON.parse(text) as PlayerResponse;
  } catch {
    return null;
  }
}

function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  const manual = tracks.filter((t) => t.kind !== "asr");
  const pool = manual.length ? manual : tracks;
  return (
    pool.find((t) => t.languageCode?.startsWith("zh")) ??
    pool.find((t) => t.languageCode?.startsWith("en")) ??
    pool[0]!
  );
}

async function fetchYoutube(url: URL, ctx: IngestContext): Promise<IngestedContent> {
  const id = videoIdOf(url);
  if (!id) throw new Error(`no video id found in ${url}`);
  const canonical = `https://www.youtube.com/watch?v=${id}`;

  // oEmbed is the reliability floor: if even this fails, there is nothing to
  // capture and the ingest as a whole should error.
  const oembedRes = await ctx.fetchImpl(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
  );
  if (!oembedRes.ok) {
    throw new Error(`YouTube oEmbed failed (HTTP ${oembedRes.status}) — video may be private or removed`);
  }
  const oembed = (await oembedRes.json().catch(() => null)) as {
    title?: string;
    author_name?: string;
  } | null;

  let player: PlayerResponse | null = null;
  try {
    player = await innertubePlayer(id, ctx);
  } catch {
    player = null;
  }
  const details = player?.videoDetails;

  // Fixed subtitle layering: built-in (InnerTube) → yt-dlp → metadata-only.
  let transcript: string | undefined;
  let transcriptVia = "";
  let reason = "no caption tracks";
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickTrack(tracks);
  if (!player) reason = "player API unavailable (PO token / throttling)";
  if (track?.baseUrl) {
    try {
      const capRes = await ctx.fetchImpl(`${track.baseUrl}&fmt=json3`);
      const text = capRes.ok ? await capRes.text() : "";
      transcript = (text.trim() ? parseJson3(text) : null) ?? undefined;
      if (transcript) transcriptVia = "builtin";
      else reason = capRes.ok ? "caption endpoint returned empty body" : `caption HTTP ${capRes.status}`;
    } catch (err) {
      reason = (err as Error).message?.slice(0, 120) ?? "caption fetch failed";
    }
  }
  if (!transcript) {
    const dump = await (ctx.ytDlpDumpJson ?? ytDlpDumpJson)(canonical);
    const subUrl = dump ? pickSubtitleUrl(dump) : null;
    if (subUrl) {
      try {
        const subRes = await ctx.fetchImpl(subUrl);
        transcript = parseSubtitlePayload(await subRes.text()) ?? undefined;
        if (transcript) transcriptVia = "yt-dlp";
      } catch {
        // stay degraded
      }
    }
  }

  const title = details?.title ?? oembed?.title ?? `YouTube ${id}`;
  const author = details?.author ?? oembed?.author_name;
  const published = player?.microformat?.playerMicroformatRenderer?.publishDate;

  const extra: Record<string, string> = { site: "YouTube" };
  if (author) extra.author = author;
  if (published) extra.published = published;
  extra.transcript = transcript ? transcriptVia : `unavailable (${reason})`;

  return {
    title,
    body: formatVideoBody({
      title,
      url: canonical,
      uploader: author,
      duration: details?.lengthSeconds ? Number(details.lengthSeconds) : undefined,
      description: details?.shortDescription,
      transcript,
    }),
    extra,
  };
}

export const youtubeAdapter: IngestAdapter = {
  name: "youtube",
  match: (url) => videoIdOf(url) != null,
  fetch: fetchYoutube,
};
