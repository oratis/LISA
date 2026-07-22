/**
 * `lisa monitor` — TUI live dashboard.
 *
 * Polls ~/.lisa/ every 2s and re-renders an in-place dashboard with:
 *   - Current mood (from set_mood-tracked file or emotions.json)
 *   - Last 5 soul commits (rolling)
 *   - Last 3 emotion events
 *   - Heartbeat last-run-at
 *   - Active session id (if any web/REPL session writing)
 *
 * Pure read-only. Doesn't touch the LLM. Quit with Ctrl-C.
 *
 * Implementation: ANSI cursor positioning. No external curses lib.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import {
  cyan,
  dim,
  green,
  grey,
  heading,
  rule,
  warn,
} from "./colors.js";
import { lisaHome } from "../paths.js";
import { soulDir } from "../soul/paths.js";
import { isBorn, readSoulSummary } from "../soul/store.js";
import { pathExists, readTextOrEmpty } from "../fs-utils.js";

const POLL_MS = 2000;

export async function runMonitor(): Promise<void> {
  if (!(await isBorn())) {
    console.log(warn("Lisa hasn't been born yet. Run `lisa birth` first."));
    return;
  }
  // Hide cursor, clear screen.
  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
  process.on("SIGINT", () => {
    // Restore cursor & clear, then exit.
    process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
    process.exit(0);
  });
  // Restore cursor on any uncaught exit too.
  process.on("exit", () => {
    process.stdout.write("\x1b[?25h");
  });

  while (true) {
    await render();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function render(): Promise<void> {
  // Move cursor to top-left, clear from there to end.
  process.stdout.write("\x1b[H\x1b[J");

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(rule(`LISA MONITOR  ·  ${now}  ·  Ctrl-C to quit`, 80));
  console.log();

  const summary = await readSoulSummary();
  if (!summary) {
    console.log(warn("readSoulSummary failed"));
    return;
  }

  // ── Mood ──
  console.log(heading("Mood"));
  const ranked = Object.entries(summary.emotions.values)
    .filter(([, v]) => Math.abs(v) > 0.05)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .slice(0, 5);
  if (ranked.length === 0) {
    console.log(`  ${dim("(calm)")}`);
  } else {
    for (const [k, v] of ranked) {
      const bar = renderBar(v);
      console.log(`  ${k.padEnd(14)} ${bar}  ${dim(v.toFixed(2))}`);
    }
  }

  // ── Recent emotion events ──
  const events = (summary.emotions.events ?? []).slice(-3);
  if (events.length > 0) {
    console.log(heading("Recent feelings"));
    for (const e of events) {
      const t = e.ts.slice(11, 19);
      console.log(
        `  ${dim(t)}  ${e.emotion} ${e.delta >= 0 ? green("+") : warn("-")}${e.delta.toFixed(2)}  ${grey(truncate(e.trigger, 60))}`,
      );
    }
  }

  // ── Recent soul commits ──
  console.log(heading("Recent soul commits"));
  try {
    const dotGit = path.join(soulDir(), ".git");
    if (await pathExists(dotGit)) {
      const log = execSync(
        `git -C "${soulDir()}" log --pretty=format:"%cr %h %s" -n 5 2>/dev/null`,
        { encoding: "utf8" },
      ).trim();
      if (log) {
        for (const line of log.split("\n")) {
          console.log(`  ${dim(line)}`);
        }
      } else {
        console.log(`  ${dim("(no commits yet)")}`);
      }
    } else {
      console.log(`  ${dim("(soul git repo not initialized)")}`);
    }
  } catch {
    console.log(`  ${dim("(git not available)")}`);
  }

  // ── Heartbeat last-run ──
  const hbFile = path.join(lisaHome(), "heartbeat-state.json");
  if (await pathExists(hbFile)) {
    try {
      const raw = await readTextOrEmpty(hbFile);
      const parsed = JSON.parse(raw) as { lastRunAt?: Record<string, string> };
      const entries = Object.entries(parsed.lastRunAt ?? {}).sort((a, b) =>
        b[1].localeCompare(a[1]),
      ).slice(0, 5);
      if (entries.length > 0) {
        console.log(heading("Heartbeat last-run"));
        for (const [name, when] of entries) {
          console.log(`  ${dim(when)}  ${name}`);
        }
      }
    } catch {
      // ignore
    }
  }

  // ── Currently set mood (from tool) ──
  const moodFile = path.join(lisaHome(), "current-mood.txt");
  if (await pathExists(moodFile)) {
    const slug = (await readTextOrEmpty(moodFile)).trim();
    if (slug) {
      console.log();
      console.log(`  ${dim("portrait:")} ${cyan(slug)}`);
    }
  }
}

function renderBar(v: number): string {
  const len = 20;
  const filled = Math.round(Math.abs(v) * len);
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  if (v < 0) return "\x1b[31m-" + bar + "\x1b[39m";
  return "\x1b[32m " + bar + "\x1b[39m";
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
