/**
 * Bilibili videos (bilibili.com/video/BV…, b23.tv short links).
 *
 * Metadata comes from the public view API (no login). Subtitles need a
 * logged-in SESSDATA cookie (community-confirmed) which the user may
 * volunteer in kb/feeds.json — absent that, or when the player API breaks,
 * the capture degrades per the fixed layering: built-in API → yt-dlp →
 * metadata + description (never a hard failure; see subtitle.ts).
 *
 * D8: single-video ingest only. No account-level scraping, no private-API
 * reverse engineering beyond these two long-public endpoints.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { kbDir } from "../../paths.js";
import type { IngestAdapter, IngestContext, IngestedContent } from "../types.js";
import { formatVideoBody, parseSubtitlePayload } from "./subtitle.js";
import { pickSubtitleUrl, ytDlpDumpJson } from "./ytdlp.js";

const BV_RE = /\/video\/(BV[0-9A-Za-z]{10})/;

interface ViewData {
  bvid: string;
  cid: number;
  title: string;
  desc?: string;
  tname?: string;
  duration?: number;
  pubdate?: number;
  owner?: { name?: string };
}

/** SESSDATA volunteered by the user in kb/feeds.json (K-H owns that file). */
async function readSessdata(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(kbDir(), "feeds.json"), "utf8");
    const parsed = JSON.parse(raw) as { sessdata?: unknown };
    return typeof parsed.sessdata === "string" && parsed.sessdata ? parsed.sessdata : null;
  } catch {
    return null;
  }
}

/** Built-in subtitle layer: player API (cookie-gated) → subtitle JSON. */
async function builtinTranscript(
  data: ViewData,
  ctx: IngestContext,
): Promise<{ transcript?: string; reason?: string }> {
  const sessdata = await readSessdata();
  if (!sessdata) {
    return { reason: "字幕需要登录态：在 kb/feeds.json 里加 \"sessdata\" 可开启" };
  }
  const res = await ctx.fetchImpl(
    `https://api.bilibili.com/x/player/v2?bvid=${data.bvid}&cid=${data.cid}`,
    { headers: { cookie: `SESSDATA=${sessdata}` } },
  );
  if (!res.ok) return { reason: `player API HTTP ${res.status}` };
  const json = (await res.json().catch(() => null)) as {
    code?: number;
    data?: { subtitle?: { subtitles?: { lan?: string; subtitle_url?: string }[] } };
  } | null;
  const subs = json?.data?.subtitle?.subtitles ?? [];
  if (json?.code !== 0 || subs.length === 0) {
    return { reason: json?.code !== 0 ? `player API code ${json?.code}` : "该视频没有字幕" };
  }
  const pick =
    subs.find((s) => s.lan?.startsWith("zh")) ?? subs.find((s) => s.subtitle_url) ?? subs[0]!;
  if (!pick.subtitle_url) return { reason: "字幕列表为空" };
  const subUrl = pick.subtitle_url.startsWith("//") ? `https:${pick.subtitle_url}` : pick.subtitle_url;
  const subRes = await ctx.fetchImpl(subUrl);
  if (!subRes.ok) return { reason: `字幕下载 HTTP ${subRes.status}` };
  const transcript = parseSubtitlePayload(await subRes.text());
  return transcript ? { transcript } : { reason: "字幕内容无法解析" };
}

async function fetchBilibili(url: URL, ctx: IngestContext): Promise<IngestedContent> {
  // b23.tv short links: resolve via the guarded fetch (it follows redirects
  // hop-by-hop); the final URL carries the BV id.
  let bv = BV_RE.exec(url.pathname)?.[1];
  if (!bv && url.hostname === "b23.tv") {
    const res = await ctx.fetchImpl(url.toString());
    bv = BV_RE.exec(new URL(res.url || url.toString()).pathname)?.[1] ?? undefined;
  }
  if (!bv) throw new Error(`no BV id found in ${url} — only bilibili.com/video/BV… links are supported`);

  const apiRes = await ctx.fetchImpl(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
  if (!apiRes.ok) throw new Error(`bilibili view API failed: HTTP ${apiRes.status}`);
  const api = (await apiRes.json().catch(() => null)) as {
    code?: number;
    message?: string;
    data?: ViewData;
  } | null;
  if (!api || api.code !== 0 || !api.data) {
    throw new Error(`bilibili view API error: ${api?.message ?? "bad response"} (code ${api?.code})`);
  }
  const data = api.data;

  // Fixed subtitle layering: built-in → yt-dlp → metadata-only.
  let transcript: string | undefined;
  let transcriptVia = "";
  let reason = "";
  try {
    const built = await builtinTranscript(data, ctx);
    transcript = built.transcript;
    transcriptVia = transcript ? "builtin" : "";
    reason = built.reason ?? "";
  } catch (err) {
    reason = (err as Error).message?.slice(0, 120) ?? "builtin subtitle fetch failed";
  }
  if (!transcript) {
    const dump = await (ctx.ytDlpDumpJson ?? ytDlpDumpJson)(`https://www.bilibili.com/video/${bv}`);
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

  const canonical = `https://www.bilibili.com/video/${bv}`;
  const extra: Record<string, string> = { site: "bilibili" };
  if (data.owner?.name) extra.author = data.owner.name;
  if (data.pubdate) extra.published = new Date(data.pubdate * 1000).toISOString();
  extra.transcript = transcript
    ? transcriptVia
    : `unavailable (${reason || "无可用字幕"})`;

  return {
    title: data.title,
    body: formatVideoBody({
      title: data.title,
      url: canonical,
      uploader: data.owner?.name,
      duration: data.duration,
      category: data.tname,
      description: data.desc,
      transcript,
    }),
    extra,
  };
}

export const bilibiliAdapter: IngestAdapter = {
  name: "bilibili",
  match: (url) =>
    ((url.hostname === "bilibili.com" || url.hostname.endsWith(".bilibili.com")) &&
      BV_RE.test(url.pathname)) ||
    url.hostname === "b23.tv",
  fetch: fetchBilibili,
};
