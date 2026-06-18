/**
 * Fetch published GitHub releases for the changelog page, at BUILD time.
 *
 * Build-time (not client-side) so visitors load static HTML — no API rate
 * limits, no JS. Fail-safe: any network/parse error returns [] so the site
 * build never breaks; the page then shows a "see releases on GitHub" fallback.
 */
export interface Release {
  name: string;
  tag: string;
  date: string; // YYYY-MM-DD
  url: string;
  body: string;
}

const RELEASES_API = "https://api.github.com/repos/oratis/LISA/releases?per_page=30";

export async function fetchReleases(): Promise<Release[]> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lisa-website" },
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && r.draft !== true)
      .map((r) => ({
        name: (r.name as string) || (r.tag_name as string) || "release",
        tag: (r.tag_name as string) || "",
        date: typeof r.published_at === "string" ? r.published_at.slice(0, 10) : "",
        url: (r.html_url as string) || "https://github.com/oratis/LISA/releases",
        body: ((r.body as string) || "").trim(),
      }));
  } catch {
    return [];
  }
}
