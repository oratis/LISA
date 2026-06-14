#!/usr/bin/env tsx
/**
 * Resident-service footprint benchmark (FOUNDATIONS §5.1).
 *
 * Real energy/CPU numbers can only come from sustained measurement on YOUR
 * machine, so this is a harness, not fabricated figures: it samples a running
 * `lisa serve` process's CPU% + RSS over a window and reports avg/peak. Pair it
 * with docs/FOOTPRINT.md (the cost model + the tunable knobs).
 *
 * Usage:
 *   lisa serve --web &                       # start the backend
 *   npx tsx scripts/footprint.ts             # auto-finds the serve process
 *   npx tsx scripts/footprint.ts --pid 1234 --seconds 120 --interval 5
 *
 * Tip: for a true IDLE baseline, leave the machine alone during the window with
 * only presence/git/agent observation on (no chat, no granted sense sources).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function findServePid(): Promise<number | undefined> {
  try {
    const { stdout } = await pexec("pgrep", ["-f", "cli.js serve"]);
    const pid = stdout.split("\n").map((s) => parseInt(s.trim(), 10)).find((n) => Number.isInteger(n) && n !== process.pid);
    return pid;
  } catch {
    return undefined;
  }
}

/** One sample of a pid's %cpu and RSS (KB) via ps. null if the process is gone. */
async function sample(pid: number): Promise<{ cpu: number; rssKb: number } | null> {
  try {
    const { stdout } = await pexec("ps", ["-o", "%cpu=,rss=", "-p", String(pid)]);
    const m = stdout.trim().split(/\s+/);
    const cpu = parseFloat(m[0] ?? "");
    const rssKb = parseInt(m[1] ?? "", 10);
    if (!Number.isFinite(cpu) || !Number.isFinite(rssKb)) return null;
    return { cpu, rssKb };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const seconds = Math.max(5, parseInt(arg("seconds") ?? "60", 10));
  const interval = Math.max(1, parseInt(arg("interval") ?? "5", 10));
  let pid = arg("pid") ? parseInt(arg("pid")!, 10) : await findServePid();

  if (!pid || !Number.isInteger(pid)) {
    console.error("No `lisa serve` process found. Start one (`lisa serve --web &`) or pass --pid <pid>.");
    process.exit(1);
  }
  console.log(`Sampling pid ${pid} every ${interval}s for ${seconds}s…`);
  console.log("(for an idle baseline: don't touch the machine, keep granted sense sources off)\n");

  const cpus: number[] = [];
  const rss: number[] = [];
  const ticks = Math.floor(seconds / interval);
  for (let i = 0; i < ticks; i++) {
    const s = await sample(pid);
    if (!s) {
      console.error(`pid ${pid} is gone — stopping.`);
      break;
    }
    cpus.push(s.cpu);
    rss.push(s.rssKb / 1024); // MB
    process.stdout.write(`  t+${i * interval}s  cpu=${s.cpu.toFixed(1)}%  rss=${(s.rssKb / 1024).toFixed(0)}MB\n`);
    if (i < ticks - 1) await sleep(interval * 1000);
  }

  if (cpus.length === 0) {
    console.error("No samples collected.");
    process.exit(1);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const peak = (a: number[]) => Math.max(...a);
  console.log("\n── footprint ──");
  console.log(`  CPU:  avg ${avg(cpus).toFixed(1)}%   peak ${peak(cpus).toFixed(1)}%`);
  console.log(`  RSS:  avg ${avg(rss).toFixed(0)}MB  peak ${peak(rss).toFixed(0)}MB`);
  console.log(`  samples: ${cpus.length} over ~${cpus.length * interval}s`);
  console.log("\nRecord this in docs/FOOTPRINT.md against your machine + config.");
}

main().catch((e) => {
  console.error("footprint failed:", e);
  process.exit(1);
});
