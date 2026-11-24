import { RECIPE_SCHEMA_VERSION, type Recipe } from "./types.js";

/**
 * Curated built-in recipes shipped with LISA. Every recipe is read-only or
 * writes only to Lisa's local KB/journal, contains zero credentials or personal
 * memory, and installs as a DISABLED draft until the user explicitly enables it.
 */
export const BUILTIN_RECIPES: readonly Recipe[] = [
  {
    version: RECIPE_SCHEMA_VERSION,
    id: "morning-briefing",
    name: "Weekday Morning Briefing",
    description:
      "Compile a concise weekday morning digest from your personal KB and active priorities without sending anything externally.",
    author: "Lisa Built-ins",
    tags: ["routine", "briefing", "read-only"],
    permissions: {
      tools: ["kb_list", "kb_search", "memory_search"],
      categories: ["read"],
      summary: "Reads your local knowledge base and memory; makes no network or write calls.",
    },
    task: {
      kind: "routine",
      title: "Weekday morning briefing",
      instruction:
        "Review recent notes in my knowledge base and active goals, then produce a crisp 5-bullet briefing for today.",
      schedule: { expr: "weekdays:08:30" },
      notify: "always",
    },
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: "rss-release-watch",
    name: "RSS Release Watcher",
    description:
      "Poll a public RSS/Atom feed and notify only when a new release entry matches your keywords.",
    author: "Lisa Built-ins",
    tags: ["watcher", "rss", "releases"],
    permissions: {
      tools: ["web_fetch"],
      categories: ["read"],
      networkHosts: ["github.com"],
      summary: "Performs read-only HTTP GET polling on the configured RSS feed URL.",
    },
    task: {
      kind: "watcher",
      title: "Release feed watch",
      instruction: "Summarize the new release highlights and note any breaking changes.",
      trigger: {
        kind: "rss",
        url: "https://github.com/oratis/LISA/releases.atom",
        keywords: ["release", "v0."],
        every: "every:1h",
        onHit: "notify",
      },
      notify: "on_hit",
    },
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: "weekly-pr-digest",
    name: "Weekly Repository Digest",
    description:
      "Inspect local git activity and produce a Friday afternoon changelog draft without pushing or commenting.",
    author: "Lisa Built-ins",
    tags: ["routine", "engineering", "read-only"],
    permissions: {
      tools: ["repo_digest", "review_diff"],
      categories: ["read"],
      summary: "Reads local repository git metadata and diffs; performs no git writes or network calls.",
    },
    task: {
      kind: "routine",
      title: "Weekly engineering digest",
      instruction:
        "Summarize merged work, open risks, and next week's priorities from this repository.",
      schedule: { expr: "weekly:fri@16:30" },
      notify: "on_change",
    },
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: "kb-reading-distiller",
    name: "Knowledge Base Distiller",
    description:
      "Review newly captured links in your knowledge base and synthesize structured wiki notes.",
    author: "Lisa Built-ins",
    tags: ["goal", "knowledge-base"],
    permissions: {
      tools: ["kb_list", "kb_read", "kb_write"],
      categories: ["read", "self"],
      summary: "Reads captured KB sources and writes distilled wiki summaries inside your local KB.",
    },
    task: {
      kind: "goal",
      title: "Distill captured reading into wiki",
      instruction:
        "Check newly captured sources in my knowledge base, synthesize concise wiki pages, and link related topics.",
      notify: "on_change",
    },
  },
];
