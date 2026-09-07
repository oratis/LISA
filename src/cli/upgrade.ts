/**
 * `lisa upgrade` — update the installed Lisa and restart the daemon.
 *
 * The tech review's note was blunt: the author's own machine runs whatever was
 * installed weeks ago, because upgrading means remembering *how* Lisa got
 * installed (brew? npm -g? a checkout?) and then remembering that the LaunchAgent
 * keeps running the old code until something kicks it. Both halves are
 * mechanical, so they live here.
 *
 * Everything that decides *what to do* is a pure function of a few facts about
 * the process (`detectInstall`, `upgradeCommands`, `compareVersions`), and
 * everything that *does* it is injectable — so the tests below cover the whole
 * decision surface without a network call or a real install.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCmd } from "../launchd.js";
import { bold, dim, fail, green, grey, heading, ok, rule, warn } from "./colors.js";
import { displayPath } from "./display-path.js";

export const PACKAGE_NAME = "@oratis/lisa";
/**
 * package.json `engines.node`, and BackendSetup.minimumNodeMajor in the Mac
 * client — keep the three in sync. upgrade.test.ts reads package.json and
 * fails if this drifts from it.
 */
export const MIN_NODE_MAJOR = 20;
/** The tap formula from README.md (`brew install oratis/tap/lisa`). */
export const BREW_FORMULA = "oratis/tap/lisa";
/**
 * Must match PLIST_LABEL in src/autostart/install.ts — that file owns the
 * label, this is a copy because it isn't exported. upgrade.test.ts reads the
 * installer and fails if the two ever drift.
 */
export const AUTOSTART_LABEL = "ai.lisa.autostart";

export type InstallFlavor = "homebrew" | "npm-global" | "source" | "unknown";

/** Everything about the environment that the detection depends on. */
export interface InstallFacts {
  /** process.argv[1] — often a symlink shim. */
  entry: string;
  /** `entry` with symlinks resolved; the same string when it can't be resolved. */
  realEntry: string;
  /** `brew --prefix`, or null when Homebrew isn't installed. */
  brewPrefix?: string | null;
  /** `npm prefix -g`, or null when npm isn't installed. */
  npmPrefix?: string | null;
  /** Nearest ancestor of `realEntry` containing a `.git`, when there is one. */
  repoRoot?: string | null;
  platform?: NodeJS.Platform;
}

export interface Detection {
  flavor: InstallFlavor;
  /** One line the user can check against reality. */
  reason: string;
}

export interface Step {
  cmd: string;
  args: string[];
}

export function formatStep(s: Step): string {
  return [s.cmd, ...s.args].join(" ");
}

/**
 * Which install is this? Ordered by how conclusive the evidence is:
 * a Cellar path can only be Homebrew; a `node_modules/@oratis/lisa` path can
 * only be a package install; a checkout is what's left when neither holds and
 * there is a git repo around the entrypoint.
 */
export function detectInstall(facts: InstallFacts): Detection {
  const real = facts.realEntry || facts.entry;
  const brewPrefix = facts.brewPrefix?.replace(/\/+$/, "") ?? "";

  if (real.includes("/Cellar/")) {
    return { flavor: "homebrew", reason: `runs from a Homebrew Cellar path (${displayPath(real)})` };
  }
  if (brewPrefix && (real.startsWith(`${brewPrefix}/opt/`) || real.startsWith(`${brewPrefix}/Cellar/`))) {
    return { flavor: "homebrew", reason: `runs from ${displayPath(brewPrefix)}` };
  }
  if (real.includes(`/node_modules/${PACKAGE_NAME}/`)) {
    return {
      flavor: "npm-global",
      reason: `installed as a package under ${displayPath(real.slice(0, real.indexOf("/node_modules/")))}`,
    };
  }
  const npmPrefix = facts.npmPrefix?.replace(/\/+$/, "") ?? "";
  if (npmPrefix && real.startsWith(`${npmPrefix}/`)) {
    return { flavor: "npm-global", reason: `runs from the npm global prefix ${displayPath(npmPrefix)}` };
  }
  if (facts.repoRoot) {
    return { flavor: "source", reason: `a source checkout at ${displayPath(facts.repoRoot)}` };
  }
  return { flavor: "unknown", reason: `can't tell from ${displayPath(real)}` };
}

/** The commands that perform the upgrade. Empty when there is nothing to run. */
export function upgradeCommands(flavor: InstallFlavor): Step[] {
  switch (flavor) {
    case "homebrew":
      // `brew update` first: without it the tap never learns the new formula.
      return [
        { cmd: "brew", args: ["update"] },
        { cmd: "brew", args: ["upgrade", BREW_FORMULA] },
      ];
    case "npm-global":
      return [{ cmd: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] }];
    default:
      return [];
  }
}

/**
 * What to tell someone whose install we won't touch. A checkout is deliberately
 * hands-off: it may hold uncommitted work, and `git pull` on someone's working
 * tree is not an upgrade command, it's a merge.
 */
export function manualInstructions(flavor: InstallFlavor, repoRoot?: string | null): string[] {
  if (flavor === "source") {
    const where = repoRoot ? `cd ${displayPath(repoRoot)} && ` : "";
    return [
      "This is a source checkout — Lisa won't touch a working tree that may hold your changes.",
      `  ${where}git pull && npm install && npm run build`,
    ];
  }
  return [
    "Couldn't identify how Lisa was installed. Pick the one that matches:",
    `  brew upgrade ${BREW_FORMULA}`,
    `  npm install -g ${PACKAGE_NAME}@latest`,
  ];
}

/**
 * Why an upgrade command failed, from the tool's own combined output.
 *
 * Mirrors classifyInstallFailure() in
 * packaging/mac-client/Sources/LisaSetup/BackendSetup.swift — both surfaces run
 * the same `npm install -g`, so they must hand out the same fix. The Mac wizard
 * gained one in #371 while `lisa upgrade` still printed npm's first line and
 * stopped, which left the CLI user at a dead end for the single most common
 * failure this command has.
 */
export type UpgradeFailure = "permissions" | "network" | "node-too-old" | "unknown";

export function classifyUpgradeFailure(output: string): UpgradeFailure {
  const o = output.toLowerCase();
  if (o.includes("eacces") || o.includes("eperm") || o.includes("permission denied")) {
    return "permissions";
  }
  if (o.includes("ebadengine") || o.includes("unsupported engine")) return "node-too-old";
  for (const needle of ["enotfound", "etimedout", "econnreset", "econnrefused", "eai_again", "network"]) {
    if (o.includes(needle)) return "network";
  }
  return "unknown";
}

/**
 * What to tell someone after a failed upgrade. The permissions branch is the
 * standard no-sudo npm prefix move, verbatim the same commands the Mac wizard
 * offers, so the two surfaces cannot drift into contradicting each other.
 */
export function failureAdvice(kind: UpgradeFailure, flavor: InstallFlavor): string[] {
  switch (kind) {
    case "permissions":
      return [
        "npm can't write to its global folder — it's owned by root.",
        "The standard fix moves global packages into your home folder (no sudo), then retries:",
        '  mkdir -p "$HOME/.npm-global"',
        '  npm config set prefix "$HOME/.npm-global"',
        `  grep -qs 'npm-global/bin' "$HOME/.zprofile" || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.zprofile"`,
        '  export PATH="$HOME/.npm-global/bin:$PATH"',
        `  npm install -g ${PACKAGE_NAME}@latest`,
      ];
    case "network":
      return ["Couldn't reach the registry. Check your connection (and any proxy or VPN), then retry."];
    case "node-too-old":
      return [`This Node.js is too old for Lisa — install Node ${MIN_NODE_MAJOR} or newer, then retry.`];
    case "unknown":
      return [
        "The message above is the tool's own. Running the command yourself shows its full output:",
        ...manualInstructions(flavor),
      ];
  }
}

export function kickstartCommand(uid: number, label = AUTOSTART_LABEL): Step {
  // -k kills the running instance first, so the agent comes back on new code.
  return { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${label}`] };
}

/** semver-lite: numeric compare of the release parts; a prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const cleaned = v.trim().replace(/^v/, "");
    const [release = "", ...rest] = cleaned.split("-");
    return {
      nums: release.split(".").map((n) => parseInt(n, 10) || 0),
      pre: rest.join("-"),
    };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 1.0.0 > 1.0.0-rc.1
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// ── I/O side ──────────────────────────────────────────────────────────

/** The version of the code that is running right now, read fresh from disk. */
export async function readLocalVersion(): Promise<string> {
  try {
    // dist/cli/upgrade.js → ../../package.json (and src/cli/upgrade.ts under tsx).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = await fs.readFile(path.resolve(here, "..", "..", "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Walk up from `start` looking for a `.git` — the "am I in a checkout" fact. */
export async function findRepoRoot(start: string): Promise<string | null> {
  let dir = path.dirname(start);
  for (let i = 0; i < 12; i++) {
    try {
      await fs.access(path.join(dir, ".git"));
      return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function gatherFacts(argv1 = process.argv[1] ?? ""): Promise<InstallFacts> {
  const entry = argv1;
  let realEntry = entry;
  try {
    realEntry = await fs.realpath(entry);
  } catch {}
  const brewPrefix = await runCmd("brew", ["--prefix"])
    .then((s) => s.trim())
    .catch(() => null);
  const npmPrefix = await runCmd("npm", ["prefix", "-g"])
    .then((s) => s.trim())
    .catch(() => null);
  return {
    entry,
    realEntry,
    brewPrefix,
    npmPrefix,
    repoRoot: await findRepoRoot(realEntry),
    platform: process.platform,
  };
}

/** The newest published version, straight from the registry via the npm CLI. */
export async function fetchPublishedVersion(): Promise<string | null> {
  try {
    const out = await runCmd("npm", ["view", PACKAGE_NAME, "version"]);
    const v = out.trim().split("\n").pop()?.trim();
    return v && /^\d/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export interface UpgradeOptions {
  /** Only compare versions; change nothing. */
  check?: boolean;
  /** Print the commands instead of running them. */
  dryRun?: boolean;
  log?: (line: string) => void;
  facts?: InstallFacts;
  localVersion?: () => Promise<string>;
  fetchLatest?: () => Promise<string | null>;
  run?: (step: Step) => Promise<string>;
  /** Is the login LaunchAgent loaded (so it holds the old code)? */
  autostartLoaded?: () => Promise<boolean>;
  uid?: number;
}

/** Reads the autostart status text rather than duplicating its plist logic. */
async function defaultAutostartLoaded(): Promise<boolean> {
  try {
    const { autostartStatus } = await import("../autostart/install.js");
    return /loaded in launchd: yes/.test(await autostartStatus());
  } catch {
    return false;
  }
}

/**
 * Returns the process exit code: 0 when there was nothing to do or the upgrade
 * succeeded, 1 when a command failed. `--check` never fails on "an upgrade is
 * available" — it is a report, and a cron line that mails its output shouldn't
 * look like an error.
 */
export async function runUpgrade(opts: UpgradeOptions = {}): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const facts = opts.facts ?? (await gatherFacts());
  const readVersion = opts.localVersion ?? readLocalVersion;
  const fetchLatest = opts.fetchLatest ?? fetchPublishedVersion;
  const run = opts.run ?? ((s: Step) => runCmd(s.cmd, s.args));
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);

  log(rule("LISA UPGRADE"));
  const detection = detectInstall(facts);
  const before = await readVersion();
  const latest = await fetchLatest();

  log(heading("Install"));
  log(`  ${dim("flavour:")}   ${bold(detection.flavor)}${grey("  " + detection.reason)}`);
  log(`  ${dim("installed:")} ${before}`);
  log(`  ${dim("published:")} ${latest ?? grey("(registry unreachable)")}`);

  const behind = latest ? compareVersions(latest, before) > 0 : false;
  if (latest) {
    if (behind) log(`  ${warn(`${before} → ${latest} available`)}`);
    else log(`  ${ok("already on the newest published version")}`);
  }

  if (opts.check) {
    log("");
    log(rule());
    log(behind ? warn(`run \`lisa upgrade\` to move to ${latest}`) : ok("up to date"));
    return 0;
  }

  const steps = upgradeCommands(detection.flavor);
  if (steps.length === 0) {
    log(heading("Nothing to run"));
    for (const line of manualInstructions(detection.flavor, facts.repoRoot)) log(`  ${line}`);
    log("");
    log(rule());
    log(warn("nothing upgraded — run one of the commands above yourself"));
    return 0;
  }

  const restart = facts.platform === "darwin" && (await (opts.autostartLoaded ?? defaultAutostartLoaded)());
  const all = restart ? [...steps, kickstartCommand(uid)] : steps;

  if (opts.dryRun) {
    log(heading("Would run"));
    for (const s of all) log(`  ${formatStep(s)}`);
    if (!restart) {
      log(`  ${dim("(no loaded LaunchAgent — nothing to restart)")}`);
    }
    log("");
    log(rule());
    log(ok("dry run — nothing changed"));
    return 0;
  }

  log(heading("Upgrading"));
  for (const s of steps) {
    log(`  ${dim("$")} ${formatStep(s)}`);
    try {
      await run(s);
    } catch (err) {
      const message = (err as Error).message;
      log(`  ${fail(message.split("\n")[0] ?? "failed")}`);
      log("");
      log(heading("What to do"));
      // Classify on the whole message: runCmd puts the command's stderr in it,
      // and the needle (EACCES, EBADENGINE, …) is rarely on the first line.
      for (const line of failureAdvice(classifyUpgradeFailure(message), detection.flavor)) {
        log(`  ${line}`);
      }
      log("");
      log(rule());
      log(fail(`\`${formatStep(s)}\` failed — Lisa is still on ${before}`));
      return 1;
    }
  }

  const after = (await probeVersion(run)) ?? (await readVersion());
  log(`  ${green("✓")} ${before} → ${after}`);

  if (restart) {
    // The LaunchAgent is still executing the old code until it is replaced.
    const kick = kickstartCommand(uid);
    log(`  ${dim("$")} ${formatStep(kick)}`);
    try {
      await run(kick);
      log(`  ${green("✓")} restarted the login agent (${AUTOSTART_LABEL})`);
    } catch (err) {
      log(`  ${warn(`couldn't restart the daemon: ${(err as Error).message.split("\n")[0]}`)}`);
      log(`  ${dim(`run it yourself: ${formatStep(kick)}`)}`);
    }
  }

  log("");
  log(rule());
  if (after === before) {
    log(warn(`still on ${before} — the registry may not have the new version yet`));
  } else {
    log(ok(`now on ${after}`));
  }
  return 0;
}

/** Ask the freshly-installed binary its version; the in-process package.json may be stale. */
async function probeVersion(run: (s: Step) => Promise<string>): Promise<string | null> {
  try {
    const out = await run({ cmd: "lisa", args: ["--version"] });
    const v = out.trim().split("\n").pop()?.trim();
    return v && /^\d/.test(v) ? v : null;
  } catch {
    return null;
  }
}
