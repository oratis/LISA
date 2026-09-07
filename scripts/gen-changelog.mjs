#!/usr/bin/env node
/**
 * gen-changelog.mjs — build CHANGELOG.md from docs/RELEASE_v*.md.
 *
 * The changelog stopped at 0.12.0 while twelve releases went on shipping, each
 * documented only in its own `docs/RELEASE_v*.md`. Keeping two hand-written
 * accounts of the same release in sync is work nobody does twice, so there is
 * one source — the release notes — and this generates the summary view.
 *
 * Per release it emits:
 *   - version + date: from the `vX.Y.Z` git tag when it exists (the date the
 *     release actually happened), otherwise the release note's own last commit
 *     date, so an unreleased note still lands in the right place;
 *   - the note's headline paragraph, verbatim, links re-pathed for a file that
 *     lives at the repo root rather than in docs/;
 *   - its `##` section titles as bullets — the shape of the release;
 *   - links to the note and to the GitHub release.
 *
 * Everything at 0.12.0 and below is hand-written and older than the release-note
 * convention. It is preserved verbatim below a marker comment and never
 * regenerated; the marker is what makes re-running this idempotent.
 *
 * Usage:
 *   node scripts/gen-changelog.mjs          # rewrite CHANGELOG.md
 *   node scripts/gen-changelog.mjs --check  # exit 1 if it is out of date
 *
 * --check needs the full history and tags (a shallow CI clone has neither),
 * which is why it is a release-time step and not a CI gate.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const REPO = "https://github.com/oratis/LISA";

/** Releases at or below this version predate the release-note convention. */
const HANDWRITTEN_THROUGH = "0.12.0";

export const MARKER =
  "<!-- gen-changelog:handwritten — everything below is hand-written and preserved verbatim; do not regenerate -->";

const HEADER = `# Changelog

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [SemVer](https://semver.org/).

Entries from ${nextAfter(HANDWRITTEN_THROUGH)} onward are generated from \`docs/RELEASE_v*.md\` by
\`npm run changelog\` — edit the release note, not this file. See
[docs/RELEASING.md](docs/RELEASING.md).`;

function nextAfter(version) {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
}

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Links in a release note are relative to docs/. This file lives at the repo
 * root, so `](PLAN_X.md)` has to become `](docs/PLAN_X.md)` or the link check
 * (rightly) fails. Absolute URLs, anchors and paths that already say docs/ or
 * climb out with ../ are left alone.
 */
function repathLinks(text) {
  return text.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, target, title = "") => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/"))
      return whole;
    if (target.startsWith("docs/") || target.startsWith("../") || target.startsWith("./"))
      return whole;
    return `](docs/${target}${title})`;
  });
}

/** Headline paragraph + `##` section titles of one release note. */
function parseNote(absPath) {
  const lines = fs.readFileSync(absPath, "utf8").split("\n");
  const headline = [];
  const sections = [];
  let seenTitle = false;
  let inFence = false;
  let collecting = false;
  let done = false;

  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (inFence) continue;

    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      seenTitle = true;
      continue;
    }
    const h2 = /^##\s+(.*?)\s*$/.exec(line);
    if (h2) {
      done = true; // the headline paragraph ends at the first section
      sections.push(h2[1]);
      continue;
    }
    if (!seenTitle || done) continue;
    if (line.trim() === "") {
      if (collecting) done = true;
      continue;
    }
    collecting = true;
    headline.push(line.trim());
  }

  return { headline: repathLinks(headline.join(" ")), sections: sections.map(repathLinks) };
}

/** The date a version shipped: its tag, else the note's last commit, else today. */
function releaseDate(version, relNotePath) {
  const tagged = git(["log", "-1", "--format=%cs", `v${version}`]);
  if (tagged) return { date: tagged, source: "tag" };
  const committed = git(["log", "-1", "--format=%cs", "--", relNotePath]);
  if (committed) return { date: committed, source: "commit" };
  return { date: new Date().toISOString().slice(0, 10), source: "today" };
}

function generate() {
  const notes = fs
    .readdirSync(DOCS)
    .map((name) => /^RELEASE_v(\d+\.\d+\.\d+)\.md$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ version: m[1], file: `docs/${m[0]}` }))
    .filter((n) => cmpVersion(n.version, HANDWRITTEN_THROUGH) > 0)
    .sort((a, b) => cmpVersion(b.version, a.version));

  const entries = notes.map(({ version, file }) => {
    const { headline, sections } = parseNote(path.join(ROOT, file));
    const { date } = releaseDate(version, file);
    const out = [`## [${version}] — ${date}`, ""];
    if (headline) out.push(headline, "");
    if (sections.length) {
      out.push(...sections.map((s) => `- ${s}`), "");
    }
    out.push(`[Release notes](${file}) · [GitHub release](${REPO}/releases/tag/v${version})`, "");
    return out.join("\n");
  });

  // Keep whatever a human wrote below the marker; on the first run, take
  // everything from the first preserved version heading onward.
  const existing = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, "utf8") : "";
  let tail = "";
  const markerAt = existing.indexOf(MARKER);
  if (markerAt >= 0) {
    tail = existing.slice(markerAt + MARKER.length).replace(/^\n+/, "");
  } else {
    const firstKept = existing.indexOf(`## [${HANDWRITTEN_THROUGH}]`);
    if (firstKept >= 0) tail = existing.slice(firstKept);
  }

  return [HEADER, "", ...entries, MARKER, "", tail.trim(), ""]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const check = process.argv.includes("--check");
const next = generate();
const current = fs.existsSync(CHANGELOG) ? fs.readFileSync(CHANGELOG, "utf8") : "";

if (check) {
  if (next === current) {
    console.log("✓ CHANGELOG.md is up to date");
    process.exit(0);
  }
  console.error("✗ CHANGELOG.md is out of date — run `npm run changelog` and commit the result.");
  process.exit(1);
}

fs.writeFileSync(CHANGELOG, next);
const count = (next.match(/^## \[/gm) ?? []).length;
console.log(`✓ wrote CHANGELOG.md (${count} version entries)`);
