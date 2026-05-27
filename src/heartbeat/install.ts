import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWrite } from "../fs-utils.js";
import { LISA_HOME } from "../paths.js";

export interface InstallOptions {
  /** Cron-like spec: "*\/30 * * * *" or shorthand like "every:30m". Default: every 30 min. */
  schedule?: string;
  /** Path to the `lisa` binary; auto-detected if omitted. */
  binPath?: string;
  /** macOS only: load the plist immediately. */
  load?: boolean;
}

const PLIST_LABEL = "ai.lisa.heartbeat";
const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
const HEARTBEAT_LOG = path.join(LISA_HOME, "heartbeat.log");

export async function installHeartbeat(
  opts: InstallOptions = {},
): Promise<{ platform: string; instructions: string; written?: string }> {
  const platform = process.platform;
  const intervalSec = parseSchedule(opts.schedule ?? "every:30m");
  const binPath = opts.binPath ?? (await resolveLisaBin());

  if (platform === "darwin") {
    const programArgv = await resolveLisaArgv(binPath);
    const plist = renderPlist({
      label: PLIST_LABEL,
      argv: programArgv,
      intervalSec,
      logPath: HEARTBEAT_LOG,
    });
    await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });
    await atomicWrite(PLIST_PATH, plist);
    let loadResult = "";
    if (opts.load) {
      try {
        await runCmd("launchctl", ["unload", PLIST_PATH]);
      } catch {}
      try {
        await runCmd("launchctl", ["load", "-w", PLIST_PATH]);
        loadResult = `\nLoaded into launchd. To stop: launchctl unload ${PLIST_PATH}`;
      } catch (err) {
        loadResult = `\nWrote plist but failed to load: ${(err as Error).message}`;
      }
    }
    return {
      platform,
      written: PLIST_PATH,
      instructions: [
        `Wrote launchd plist: ${PLIST_PATH}`,
        `  binary: ${binPath}`,
        `  interval: every ${intervalSec}s`,
        `  log:    ${HEARTBEAT_LOG}`,
        ``,
        opts.load
          ? loadResult.trim()
          : `To start: launchctl load -w ${PLIST_PATH}\nTo stop:  launchctl unload ${PLIST_PATH}`,
      ].join("\n"),
    };
  }

  // Linux / WSL → cron snippet (do not write to user's crontab automatically)
  const approx = secondsToCronApprox(intervalSec);
  const cmd = `${binPath} heartbeat run >> ${HEARTBEAT_LOG} 2>&1`;
  const lines = [
    `Lisa doesn't auto-edit your crontab on this platform. Add this line manually:`,
    ``,
    `  ${approx.cron}  ${cmd}`,
    ``,
  ];
  if (approx.snapped) {
    lines.push(
      `Note: requested ${formatSec(intervalSec)} doesn't map cleanly to a single cron expression`,
      `(cron can't span midnight evenly with hour-divisors other than 1,2,3,4,6,8,12).`,
      `Snapped to the nearest safe divisor: ${formatSec(approx.effectiveSec)}.`,
      ``,
    );
  }
  lines.push(`Run \`crontab -e\` and append it. Verify with \`crontab -l\`.`);
  return {
    platform,
    instructions: lines.join("\n"),
  };
}

function renderPlist(opts: {
  label: string;
  argv: string[];
  intervalSec: number;
  logPath: string;
}): string {
  const argvXml = [...opts.argv, "heartbeat", "run"]
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${opts.label}</string>
    <key>ProgramArguments</key>
    <array>
${argvXml}
    </array>
    <key>StartInterval</key>
    <integer>${opts.intervalSec}</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${opts.logPath}</string>
    <key>StandardErrorPath</key>
    <string>${opts.logPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!),
  );
}

export async function uninstallHeartbeat(): Promise<string> {
  if (process.platform !== "darwin") {
    return "Auto-uninstall only supported on macOS. Edit your crontab manually.";
  }
  try {
    await runCmd("launchctl", ["unload", PLIST_PATH]);
  } catch {}
  try {
    await fs.unlink(PLIST_PATH);
    return `Removed ${PLIST_PATH}`;
  } catch (err) {
    return `Could not remove ${PLIST_PATH}: ${(err as Error).message}`;
  }
}

function parseSchedule(spec: string): number {
  // "every:30m" / "every:1h" / "every:5m"
  const m = spec.match(/^every:(\d+)([smh])$/);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!;
    return n * (unit === "s" ? 1 : unit === "m" ? 60 : 3600);
  }
  const sec = parseInt(spec, 10);
  if (Number.isFinite(sec) && sec > 0) return sec;
  return 1800; // default 30 min
}

/** Cron field divisors that span the field cleanly (no wrap-around gap). */
const SAFE_MIN_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const SAFE_HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12];

function pickClosest(target: number, choices: readonly number[]): number {
  return choices.reduce((best, v) =>
    Math.abs(v - target) < Math.abs(best - target) ? v : best,
  );
}

/**
 * Convert an interval in seconds to a cron expression.
 *
 * cron's `*\/N` syntax only spans a field evenly when N divides the field's
 * range (60 for minutes, 24 for hours). For other values cron wraps at the
 * field boundary, producing a short final gap (e.g. `*\/5` on hours fires at
 * 0,5,10,15,20 then 0 — only 4h between 20 and 0). For minute values >59 or
 * hour values >23 cron silently ignores the field. To keep the printed line
 * valid and the schedule even, we snap to the nearest safe divisor and let the
 * caller report the rounding to the user.
 */
function secondsToCronApprox(sec: number): {
  cron: string;
  snapped: boolean;
  effectiveSec: number;
} {
  // <1 minute → fall back to every-minute (cron's smallest granularity)
  if (sec < 60) {
    return { cron: "* * * * *", snapped: sec !== 60, effectiveSec: 60 };
  }

  // 1m–<1h → minute granularity, snap to divisor of 60
  if (sec < 3600) {
    const requestedMin = sec / 60;
    const min = pickClosest(requestedMin, SAFE_MIN_DIVISORS);
    return {
      cron: min === 1 ? "* * * * *" : `*/${min} * * * *`,
      snapped: min !== requestedMin,
      effectiveSec: min * 60,
    };
  }

  // 1h–24h → hour granularity, snap to divisor of 24
  if (sec <= 24 * 3600) {
    const requestedH = sec / 3600;
    const hours = pickClosest(requestedH, SAFE_HOUR_DIVISORS);
    if (sec === 24 * 3600) {
      return { cron: "0 0 * * *", snapped: false, effectiveSec: 24 * 3600 };
    }
    return {
      cron: hours === 1 ? "0 * * * *" : `0 */${hours} * * *`,
      snapped: hours !== requestedH,
      effectiveSec: hours * 3600,
    };
  }

  // >24h → day granularity
  const requestedD = sec / 86400;
  if (requestedD >= 7) {
    return { cron: "0 0 * * 0", snapped: true, effectiveSec: 7 * 86400 };
  }
  const days = Math.max(1, Math.round(requestedD));
  return {
    cron: days === 1 ? "0 0 * * *" : `0 0 */${days} * *`,
    snapped: days !== requestedD,
    effectiveSec: days * 86400,
  };
}

function formatSec(sec: number): string {
  if (sec % 86400 === 0) {
    const d = sec / 86400;
    return d === 1 ? "1 day" : `${d} days`;
  }
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (sec % 60 === 0) {
    const m = sec / 60;
    return m === 1 ? "1 minute" : `${m} minutes`;
  }
  return `${sec} seconds`;
}

async function resolveLisaBin(): Promise<string> {
  // Used for the human-readable `instructions` line + the cron snippet.
  try {
    const out = await runCmd("which", ["lisa"]);
    const trimmed = out.trim();
    if (trimmed) return trimmed;
  } catch {}
  const here = path.resolve(process.cwd(), "dist", "cli.js");
  try {
    await fs.access(here);
    return `node ${here}`;
  } catch {}
  return "lisa";
}

/** Returns argv elements for launchd plist (one entry per array slot). */
async function resolveLisaArgv(displayedBin: string): Promise<string[]> {
  // If displayedBin starts with "node ", split it.
  if (displayedBin.startsWith("node ")) {
    const nodePath = (await runCmd("which", ["node"]).catch(() => "node")).trim() || "node";
    return [nodePath, displayedBin.slice("node ".length)];
  }
  return [displayedBin];
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`)),
    );
  });
}
