/**
 * `lisa status` — quick snapshot of the current Lisa instance.
 *
 * Designed for "I haven't logged in for 2 weeks, what's been going on" —
 * shows current mood, recent commits, last reflection, pending objections,
 * desire summary, executable skill state.
 *
 * Reads ~/.lisa/ directly; doesn't talk to any LLM. Fast (<1s).
 */
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { LISA_HOME, REFLECTIONS_DIR, SESSIONS_DIR } from "../paths.js";
import {
  isBorn,
  listDesires,
  listJournalDates,
  readSoulSummary,
} from "../soul/store.js";
import { SOUL_DIR } from "../soul/paths.js";
import { discoverExecutableSkills } from "../skills/executable.js";
import { listSkills } from "../skills/manager.js";
import { listConfiguredProviders } from "../providers/registry.js";
import {
  bold,
  dim,
  fail,
  grey,
  green,
  heading,
  note,
  ok,
  red,
  rule,
  warn,
} from "./colors.js";
import { pathExists, readTextOrEmpty } from "../fs-utils.js";

export async function runStatus(): Promise<void> {
  console.log(rule("LISA STATUS"));

  // ── Identity ─────────────────────────────────────────────────────────
  if (!(await isBorn())) {
    console.log(fail("Lisa hasn't been born yet."));
    console.log(note("Run: lisa birth"));
    return;
  }
  const summary = await readSoulSummary();
  if (!summary) {
    console.log(fail("Soul read failed even though seed.json exists."));
    return;
  }

  console.log(heading("Identity"));
  console.log(`  ${bold(summary.name)}  ${dim(`born ${summary.seed.bornAt.slice(0, 10)}`)}`);
  console.log(
    `  ${dim("big5")}  O${pct(summary.seed.bigFive.openness)} C${pct(summary.seed.bigFive.conscientiousness)} E${pct(summary.seed.bigFive.extraversion)} A${pct(summary.seed.bigFive.agreeableness)} N${pct(summary.seed.bigFive.neuroticism)}`,
  );
  console.log(`  ${dim("purpose")}  ${truncate(summary.purpose, 100)}`);
  if (summary.tampered.length > 0) {
    console.log(warn(`tampered files: ${summary.tampered.join(", ")}`));
  }

  // ── Mood ─────────────────────────────────────────────────────────────
  console.log(heading("Emotional state"));
  const ranked = Object.entries(summary.emotions.values)
    .filter(([, v]) => Math.abs(v) > 0.05)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .slice(0, 5);
  if (ranked.length === 0) {
    console.log(`  ${dim("(emotionally calm)")}`);
  } else {
    for (const [k, v] of ranked) {
      const bar = renderBar(v);
      console.log(`  ${k.padEnd(14)} ${bar}  ${dim(v.toFixed(2))}`);
    }
  }
  const events = summary.emotions.events ?? [];
  if (events.length > 0) {
    const last = events[events.length - 1]!;
    console.log(`  ${dim("last:")} ${last.emotion} ${last.delta >= 0 ? "+" : ""}${last.delta.toFixed(2)} — ${truncate(last.trigger, 60)}`);
  }

  // ── Desires ──────────────────────────────────────────────────────────
  console.log(heading("Desires"));
  const desires = await listDesires();
  if (desires.length === 0) {
    console.log(`  ${dim("(none)")}`);
  } else {
    const actionable = desires.filter((d) => d.actionable);
    const dormant = desires.filter((d) => !d.actionable);
    for (const d of actionable) {
      console.log(`  ${green("●")} ${d.what}  ${dim("[heartbeat-active]")}`);
    }
    for (const d of dormant) {
      console.log(`  ${grey("○")} ${d.what}`);
    }
  }

  // ── Recent activity ──────────────────────────────────────────────────
  console.log(heading("Recent activity"));
  const journals = (await listJournalDates()).slice(-5).reverse();
  if (journals.length > 0) {
    console.log(`  ${dim("last journal entries:")}`);
    for (const date of journals) {
      console.log(`    ${date}`);
    }
  }
  // Soul git history (if available)
  try {
    const dotGit = path.join(SOUL_DIR, ".git");
    if (await pathExists(dotGit)) {
      const log = execSync(
        `git -C "${SOUL_DIR}" log --pretty=format:"%cr %s" -n 5 2>/dev/null`,
        { encoding: "utf8" },
      );
      const lines = log.split("\n").filter(Boolean);
      if (lines.length > 0) {
        console.log(`  ${dim("recent soul commits:")}`);
        for (const l of lines) console.log(`    ${dim(l)}`);
      }
    }
  } catch {
    // git not available or empty repo — skip silently
  }

  // ── Sessions / reflections ───────────────────────────────────────────
  const sessionCount = await countDir(SESSIONS_DIR);
  const reflCount = await countDir(REFLECTIONS_DIR);
  console.log(heading("History"));
  console.log(`  ${dim("sessions:")}     ${sessionCount}`);
  console.log(`  ${dim("reflections:")}  ${reflCount}`);
  console.log(`  ${dim("journal days:")} ${(await listJournalDates()).length}`);

  // ── Skills ───────────────────────────────────────────────────────────
  const skills = await listSkills();
  const executable = await discoverExecutableSkills();
  console.log(heading("Skills"));
  console.log(`  ${dim("markdown skills:")}  ${skills.length}`);
  if (executable.length > 0) {
    const approved = executable.filter((c) => c.status === "approved-current");
    const pending = executable.filter((c) => c.status !== "approved-current");
    console.log(`  ${dim("executable:")}        ${approved.length} loaded, ${pending.length} pending`);
    for (const c of pending) {
      console.log(warn(`  ${c.slug} — ${c.status}`));
    }
  }

  // ── Providers ────────────────────────────────────────────────────────
  console.log(heading("LLM providers"));
  const provs = listConfiguredProviders();
  for (const p of provs) {
    if (p.configured) console.log(ok(p.name));
    else console.log(`  ${dim("·")} ${dim(p.name + " (no key)")}`);
  }

  // ── Heartbeat ────────────────────────────────────────────────────────
  const hbStateFile = path.join(LISA_HOME, "heartbeat-state.json");
  if (await pathExists(hbStateFile)) {
    try {
      const raw = await readTextOrEmpty(hbStateFile);
      const parsed = JSON.parse(raw) as { lastRunAt?: Record<string, string> };
      const entries = Object.entries(parsed.lastRunAt ?? {});
      if (entries.length > 0) {
        console.log(heading("Heartbeat"));
        for (const [name, when] of entries) {
          console.log(`  ${dim(name.padEnd(28))} ${dim(when)}`);
        }
      }
    } catch {
      // ignore parse error
    }
  }

  console.log();
  console.log(rule());
}

function pct(v: number): number {
  return Math.round(v * 100);
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function renderBar(v: number): string {
  const len = 12;
  const filled = Math.round(Math.abs(v) * len);
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  if (v < 0) return red("-" + bar);
  return green(" " + bar);
}

async function countDir(dir: string): Promise<number> {
  try {
    const items = await fs.readdir(dir);
    return items.length;
  } catch {
    return 0;
  }
}
