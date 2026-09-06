#!/usr/bin/env node
/**
 * check-readme-drift.mjs — keep the English and Chinese docs structurally in
 * sync.
 *
 * Compares the *heading tree* (levels and order, text ignored) of each pair:
 *
 *   README.md      ↔ README.zh-CN.md
 *   docs/GUIDE.md  ↔ docs/GUIDE.zh-CN.md
 *
 * A translation may lag in wording, but a section that exists in one language
 * and not the other is drift — that is what this catches. Headings inside
 * fenced code blocks (shell comments like `# 1. install`) are ignored.
 *
 * Usage:
 *   node scripts/check-readme-drift.mjs                    # default pairs
 *   node scripts/check-readme-drift.mjs a.md:b.md [c.md:d.md …]
 *
 * Exit code 1 on drift, with a side-by-side diff of where the trees diverge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PAIRS = [
  ["README.md", "README.zh-CN.md"],
  ["docs/GUIDE.md", "docs/GUIDE.zh-CN.md"],
];

const pairs = process.argv.slice(2).length
  ? process.argv.slice(2).map((arg) => {
      const [a, b] = arg.split(":");
      if (!a || !b) {
        console.error(`expected a.md:b.md, got "${arg}"`);
        process.exit(2);
      }
      return [a, b];
    })
  : DEFAULT_PAIRS;

/** ATX headings outside fenced code blocks → [{level, text, line}]. */
export function headingTree(markdown) {
  const out = [];
  let inFence = false;
  let fenceChar = "";
  markdown.split("\n").forEach((line, i) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        return;
      }
      if (ch === fenceChar) inFence = false;
      return;
    }
    if (inFence) return;
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

function show(h) {
  return h ? `${"#".repeat(h.level)} ${h.text}  (line ${h.line})` : "— (missing)";
}

let drift = false;

for (const [a, b] of pairs) {
  const fa = path.resolve(ROOT, a);
  const fb = path.resolve(ROOT, b);
  for (const f of [fa, fb]) {
    if (!fs.existsSync(f)) {
      console.error(`✗ ${path.relative(ROOT, f)} does not exist`);
      drift = true;
    }
  }
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) continue;

  const ta = headingTree(fs.readFileSync(fa, "utf8"));
  const tb = headingTree(fs.readFileSync(fb, "utf8"));
  const shapeA = ta.map((h) => h.level).join(",");
  const shapeB = tb.map((h) => h.level).join(",");

  if (shapeA === shapeB) {
    console.log(`✓ ${a} ↔ ${b}: ${ta.length} headings, same tree`);
    continue;
  }

  drift = true;
  console.error(`✗ ${a} ↔ ${b}: heading trees differ (${ta.length} vs ${tb.length} headings)\n`);
  const n = Math.max(ta.length, tb.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    if ((ta[i]?.level ?? 0) !== (tb[i]?.level ?? 0)) {
      firstDiff = i;
      break;
    }
  }
  // Print a window around the first divergence. Everything after a fork differs
  // by construction, so a cap keeps the CI log readable — fixing the first fork
  // and re-running is the workflow anyway.
  const MAX_ROWS = 30;
  const from = Math.max(0, firstDiff - 2);
  const to = Math.min(n, from + MAX_ROWS);
  for (let i = from; i < to; i++) {
    const same = (ta[i]?.level ?? 0) === (tb[i]?.level ?? 0);
    const mark = same ? " " : "!";
    console.error(`  ${mark} ${String(i + 1).padStart(3)}  ${show(ta[i])}`);
    console.error(`  ${mark}      ${show(tb[i])}`);
  }
  if (to < n) console.error(`  … ${n - to} more heading(s) not shown`);
  console.error("");
}

if (drift) {
  console.error("Headings must match in level and order (text may differ). Add, remove or re-level the section in the other language.");
  process.exit(1);
}
