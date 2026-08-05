/**
 * `lisa kb <add|list|search|brief>` — the knowledge base from the terminal.
 *
 *   lisa kb add <url> [--title T] [--tags a,b] [--force]   Ingest a link (Layer 1)
 *   lisa kb list [wiki|sources]                            Entries, newest first
 *   lisa kb search <query>                                 TF-IDF search
 *   lisa kb brief [date]                                   Print a daily brief (K-H)
 *
 * Mirrors the mail subcommand shape: full passthrough args (cli-args.ts), the
 * handler owns all of its flags.
 */

function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { flags, rest };
}

const USAGE =
  "usage: lisa kb add <url> [--title T] [--tags a,b] [--force]\n" +
  "       lisa kb list [wiki|sources]\n" +
  "       lisa kb search <query>\n" +
  "       lisa kb brief [YYYY-MM-DD]";

export async function runKbCommand(args: string[]): Promise<number> {
  const [sub, ...tail] = args;
  switch (sub) {
    case "add": {
      const { flags, rest } = parseFlags(tail);
      const url = rest[0];
      if (!url) {
        console.error("usage: lisa kb add <url> [--title T] [--tags a,b] [--force]");
        return 2;
      }
      const { ingestUrl } = await import("../kb/ingest/index.js");
      try {
        const res = await ingestUrl(url, {
          title: flags.title,
          tags: flags.tags ? flags.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          force: flags.force === "true",
        });
        if (res.deduped) {
          console.log(`already saved: sources/${res.entry.slug}  "${res.entry.title}" (--force to re-capture)`);
        } else {
          console.log(`saved: sources/${res.entry.slug}  "${res.entry.title}"  via ${res.via}`);
          const t = res.entry.extra?.transcript;
          if (t?.startsWith("unavailable")) {
            console.log(`note: transcript ${t} — metadata + description captured; paste a transcript with kb_add if you have one`);
          }
        }
        return 0;
      } catch (err) {
        console.error(`ingest failed: ${(err as Error).message}`);
        return 1;
      }
    }
    case "list": {
      const layer = tail[0] === "wiki" || tail[0] === "sources" ? tail[0] : undefined;
      const { listEntries } = await import("../kb/store.js");
      const entries = await listEntries(layer);
      if (entries.length === 0) {
        console.log("(knowledge base is empty — `lisa kb add <url>` or capture from chat)");
        return 0;
      }
      for (const e of entries) {
        const date = (e.updated ?? e.created ?? "").slice(0, 10);
        const tags = e.tags.length ? `  #${e.tags.join(" #")}` : "";
        console.log(`${e.layer === "wiki" ? "wiki  " : "source"} ${date}  ${e.slug}  ${e.title}${tags}`);
      }
      return 0;
    }
    case "search": {
      const query = tail.join(" ").trim();
      if (!query) {
        console.error("usage: lisa kb search <query>");
        return 2;
      }
      const { searchKb } = await import("../kb/search.js");
      const hits = await searchKb(query, 10);
      if (hits.length === 0) {
        console.log("(no matches)");
        return 0;
      }
      for (const h of hits) {
        console.log(`[${h.layer}/${h.slug}] ${h.title} (score=${h.score.toFixed(2)})\n  ${h.excerpt}\n`);
      }
      return 0;
    }
    case "brief": {
      // Daily briefs are written by the feeds service (K-H) as
      // sources/brief-<date>.md — searchable, linkable Layer-1 entries.
      const { listEntries, readEntry } = await import("../kb/store.js");
      const wanted = tail[0]; // optional YYYY-MM-DD
      const briefs = (await listEntries("sources")).filter((e) =>
        wanted ? e.slug.startsWith(`brief-${wanted}`) : /^brief-\d{4}-\d{2}-\d{2}/.test(e.slug),
      );
      const target = briefs[0];
      if (!target) {
        console.log(
          wanted
            ? `(no brief for ${wanted})`
            : "(no briefs yet — add feeds to ~/.lisa/kb/feeds.json to enable the daily brief)",
        );
        return 0;
      }
      const entry = await readEntry("sources", target.slug);
      if (!entry) {
        console.log(`(brief ${target.slug} unreadable)`);
        return 1;
      }
      console.log(`# ${entry.title}\n`);
      console.log(entry.body);
      return 0;
    }
    default:
      console.error(USAGE);
      return sub ? 2 : 0;
  }
}
