#!/usr/bin/env node
/**
 * check-md-links.mjs — verify that every *relative* link in the repo's
 * Markdown docs points at something that exists.
 *
 * Zero dependencies, works offline (external URLs are deliberately not
 * fetched — that is what makes this reliable in CI). Checks:
 *
 *   - inline links `[text](target)` and `[text](<target with spaces>)`
 *   - reference definitions `[id]: target`
 *   - HTML `href="…"` / `src="…"` attributes (the READMEs use <img>/<a>)
 *   - `#anchor` fragments on Markdown targets, against GitHub's heading
 *     slugs (github-slugger rules) plus explicit `<a id="…">` / `<a name="…">`
 *
 * Fenced code blocks and inline code spans are skipped. Absolute URLs,
 * `mailto:`, `javascript:` and `data:` links are ignored.
 *
 * Usage:
 *   node scripts/check-md-links.mjs                 # default roots (below)
 *   node scripts/check-md-links.mjs docs README.md  # explicit files / dirs
 *
 * Exit code 1 when any link is broken; every offender is printed as
 * `file:line: target — reason`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROOTS = ["README.md", "README.zh-CN.md", "CHANGELOG.md", "docs", ".codex"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "research"]);

/**
 * Repo-relative targets that are referenced on purpose before they exist, with
 * the reason. The check FAILS once such a file appears, so an exemption cannot
 * outlive its cause — you are forced to delete the entry rather than let it rot
 * into a permanent hole in the check.
 */
const PENDING = new Map([]);

const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;

/** Collect *.md files under the requested roots (files are taken as-is). */
function collect(rel) {
  const abs = path.resolve(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`no such file or directory: ${rel}`);
    process.exit(2);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...collect(path.join(rel, entry.name)));
    } else if (entry.name.endsWith(".md")) {
      out.push(path.join(abs, entry.name));
    }
  }
  return out;
}

/**
 * Blank out fenced code blocks, keeping line numbers intact so a `#` inside a
 * shell snippet is never mistaken for a heading and a URL in an example is
 * never mistaken for a link.
 */
function stripFences(text) {
  let inFence = false;
  let fenceChar = "";
  return text
    .split("\n")
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const ch = fence[1][0];
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
          return "";
        }
        if (ch === fenceChar) {
          inFence = false;
          return "";
        }
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

/**
 * stripFences plus inline code spans, for link scanning only. Headings must NOT
 * go through this: `### `~/.lisa/config.env`` is entirely a code span, and
 * blanking it would erase an anchor that GitHub happily generates.
 */
function stripCode(text) {
  // Inline code: `…` (longest run of backticks wins, as in CommonMark).
  return stripFences(text).replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length));
}

/** GitHub's heading → anchor rule (github-slugger): lowercase, drop punctuation, spaces → '-'. */
export function githubSlug(heading) {
  // Tag-stripping must not reach inside code spans: GitHub renders `<slug>` in
  // `~/.lisa/skills/<slug>/` as literal text, so "slug" belongs in the anchor.
  // Split on code spans, clean only the prose halves, then rejoin.
  let text = heading
    .trim()
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/`/g, ""); // a code span: keep verbatim
      return part
        .replace(/<[^>]+>/g, "") // html tags
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links → text
    })
    .join("");
  text = text.replace(/`/g, "");
  text = text.toLowerCase();
  text = text.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "");
  text = text.replace(/\s/g, "-");
  return text;
}

/** All anchors a Markdown file exposes: heading slugs (deduped GitHub-style) + explicit <a id/name>. */
const anchorCache = new Map();
function anchorsOf(absMd) {
  if (anchorCache.has(absMd)) return anchorCache.get(absMd);
  const set = new Set();
  const raw = fs.readFileSync(absMd, "utf8");
  const text = stripFences(raw);
  const seen = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = githubSlug(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    set.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of raw.matchAll(/<a\s+(?:[^>]*\s)?(?:id|name)=["']([^"']+)["']/g)) set.add(m[1]);
  anchorCache.set(absMd, set);
  return set;
}

/** Yield {line, target} for every link-ish thing in a file. */
function* linksIn(text) {
  const lines = stripCode(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // [text](<target>) or [text](target "title")
    for (const m of line.matchAll(/\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+["'(][^)]*)?\)/g)) {
      yield { line: i + 1, target: m[1] ?? m[2] };
    }
    // [id]: target
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/.exec(line);
    if (ref) yield { line: i + 1, target: ref[1] ?? ref[2] };
    // href="…" / src="…"
    for (const m of line.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      yield { line: i + 1, target: m[1] };
    }
  }
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

const files = roots.flatMap(collect);
const problems = [];
const pending = new Set();

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const { line, target } of linksIn(text)) {
    if (!target || isExternal(target)) continue;
    const [rawPath, ...frag] = target.split("#");
    const fragment = frag.join("#");
    let filePath;
    try {
      filePath = decodeURIComponent(rawPath.split("?")[0]);
    } catch {
      filePath = rawPath.split("?")[0];
    }
    const abs = filePath ? path.resolve(path.dirname(file), filePath) : file;
    const rel = path.relative(ROOT, file);
    if (filePath && !fs.existsSync(abs)) {
      const pendingReason = PENDING.get(path.relative(ROOT, abs));
      if (pendingReason) {
        pending.add(`${path.relative(ROOT, abs)} — ${pendingReason}`);
        continue;
      }
      problems.push(`${rel}:${line}: ${target} — target does not exist`);
      continue;
    }
    if (fragment && abs.endsWith(".md") && fs.statSync(abs).isFile()) {
      const anchors = anchorsOf(abs);
      if (!anchors.has(fragment)) {
        problems.push(
          `${rel}:${line}: ${target} — no heading/anchor "#${fragment}" in ${path.relative(ROOT, abs)}`,
        );
      }
    }
  }
}

// A PENDING entry whose file now exists is stale: delete it, don't keep a hole.
for (const [rel, reason] of PENDING) {
  if (fs.existsSync(path.resolve(ROOT, rel))) {
    problems.push(
      `${rel} now exists — drop it from PENDING in ${path.basename(fileURLToPath(import.meta.url))} (was: ${reason})`,
    );
  }
}

for (const p of pending) console.warn(`! pending: ${p}`);

if (problems.length) {
  console.error(`✗ ${problems.length} broken relative link(s):\n`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`✓ relative links resolve in ${files.length} Markdown file(s)`);
