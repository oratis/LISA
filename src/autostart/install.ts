/**
 * Login autostart — keep the LISA backend (`lisa serve --web`) running from
 * login onward, so the Mac apps / island / channels find it already up.
 *
 * macOS: a LaunchAgent with RunAtLoad + KeepAlive (starts at login, restarts
 * on crash). Linux/WSL: print a systemd --user unit the user installs manually
 * (we don't touch their unit files automatically, mirroring the heartbeat
 * installer's hands-off stance on crontab).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { lisaGlobalHome } from "../paths.js";
import { escapeXml, resolveLisaArgv, resolveLisaBin, runCmd } from "../launchd.js";

export interface AutostartOptions {
  /** Web UI port. Default 5757 (the port the Mac apps load). */
  port?: number;
  /** Channel adapters to also start (comma-list or "all"). */
  channels?: string[];
  /** Shortcut for channels:["imessage"] (macOS). */
  imessage?: boolean;
  /** Path to the `lisa` binary; auto-detected if omitted. */
  binPath?: string;
  /** macOS only: load the agent immediately (don't wait for next login). */
  load?: boolean;
}

const PLIST_LABEL = "ai.lisa.autostart";
const PLIST_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${PLIST_LABEL}.plist`,
);
/**
 * Two logs, on purpose (T-6). The process writes its own operational log to
 * SERVE_LOG via LISA_LOG_FILE, where src/log.ts rotates it at 10 MB × 5 —
 * launchd rotates nothing, and the v0.24 review found multi-hundred-MB
 * autostart.log files on daily-driver machines. launchd's own capture is
 * aimed at a *separate* file so it only collects what escapes the logger
 * (crash stacks, node warnings, third-party console output) and stays small.
 * They are computed at call time, not at module load, so LISA_HOME still
 * decides the location.
 */
function serveLogPath(): string {
  return path.join(lisaGlobalHome(), "serve.log");
}
function launchdLogPath(): string {
  return path.join(lisaGlobalHome(), "serve.launchd.log");
}

/** The `serve …` argv tail that the agent launches. Exported for testing. */
export function serveArgs(opts: AutostartOptions): string[] {
  const args = ["serve", "--web"];
  if (opts.port && opts.port !== 5757) args.push("--port", String(opts.port));
  const channels = opts.imessage ? ["imessage"] : opts.channels ?? [];
  if (channels.length) args.push("--channels", channels.join(","));
  return args;
}

export async function installAutostart(
  opts: AutostartOptions = {},
): Promise<{ platform: string; instructions: string; written?: string }> {
  const platform = process.platform;
  const binPath = opts.binPath ?? (await resolveLisaBin());
  const tail = serveArgs(opts);

  if (platform === "darwin") {
    const programArgv = [...(await resolveLisaArgv(binPath)), ...tail];
    const plist = renderPlist({
      label: PLIST_LABEL,
      argv: programArgv,
      logPath: launchdLogPath(),
      env: { LISA_LOG_FILE: serveLogPath() },
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
        loadResult = `\nLoaded into launchd — Lisa is starting now and at every login.\nTo stop: launchctl unload ${PLIST_PATH}`;
      } catch (err) {
        loadResult = `\nWrote plist but failed to load: ${(err as Error).message}`;
      }
    }
    return {
      platform,
      written: PLIST_PATH,
      instructions: [
        `Wrote launchd agent: ${PLIST_PATH}`,
        `  runs:  ${[binPath, ...tail].join(" ")}`,
        `  log:   ${serveLogPath()} (rotated by Lisa at 10MB, 5 kept)`,
        `  raw:   ${launchdLogPath()} (crash output launchd captures directly)`,
        `  when:  at login + restarts if it exits (KeepAlive)`,
        ``,
        opts.load
          ? loadResult.trim()
          : `To start now (and every login): launchctl load -w ${PLIST_PATH}\nTo stop / disable:              launchctl unload ${PLIST_PATH}`,
      ].join("\n"),
    };
  }

  // Linux / WSL → systemd --user unit snippet (hands-off; we don't write it).
  const cmd = `${binPath} ${tail.join(" ")}`;
  const unitPath = "~/.config/systemd/user/lisa.service";
  const unit = [
    `[Unit]`,
    `Description=LISA backend (web UI + channels)`,
    `After=network-online.target`,
    ``,
    `[Service]`,
    `ExecStart=${cmd}`,
    `Restart=on-failure`,
    `RestartSec=5`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
  ].join("\n");
  const instructions = [
    `Lisa doesn't edit your systemd units automatically. To autostart at login:`,
    ``,
    `  mkdir -p ~/.config/systemd/user`,
    `  cat > ${unitPath} <<'EOF'`,
    unit,
    `EOF`,
    `  systemctl --user daemon-reload`,
    `  systemctl --user enable --now lisa.service`,
    ``,
    `  # so it runs without you being logged in (optional):`,
    `  loginctl enable-linger "$USER"`,
    ``,
    `Logs:   journalctl --user -u lisa.service -f`,
    `Disable: systemctl --user disable --now lisa.service`,
  ].join("\n");
  return { platform, instructions };
}

export async function uninstallAutostart(): Promise<string> {
  if (process.platform !== "darwin") {
    return "Auto-uninstall only supported on macOS. Run: systemctl --user disable --now lisa.service";
  }
  try {
    await runCmd("launchctl", ["unload", PLIST_PATH]);
  } catch {}
  try {
    await fs.unlink(PLIST_PATH);
    return `Removed ${PLIST_PATH} — Lisa will no longer start at login.`;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return "Autostart was not installed (nothing to remove).";
    return `Could not remove ${PLIST_PATH}: ${e.message}`;
  }
}

export async function autostartStatus(): Promise<string> {
  if (process.platform !== "darwin") {
    return "Status check only supported on macOS. Try: systemctl --user status lisa.service";
  }
  let installed = false;
  try {
    await fs.access(PLIST_PATH);
    installed = true;
  } catch {}
  if (!installed) return "Autostart: not installed. Enable with `lisa autostart install --load`.";
  let loaded = false;
  try {
    const out = await runCmd("launchctl", ["list"]);
    loaded = out.includes(PLIST_LABEL);
  } catch {}
  return [
    `Autostart: installed (${PLIST_PATH})`,
    `  loaded in launchd: ${loaded ? "yes — running / will run at login" : "no — run `launchctl load -w " + PLIST_PATH + "`"}`,
    `  log: ${serveLogPath()} (rotated at 10MB, 5 kept)`,
    `  raw: ${launchdLogPath()}`,
  ].join("\n");
}

/** Render the macOS LaunchAgent plist. Exported for testing. */
export function renderPlist(opts: {
  label: string;
  argv: string[];
  /** Where launchd itself captures stdout/stderr (NOT the rotated main log). */
  logPath: string;
  /** Extra EnvironmentVariables entries, merged over the PATH default. */
  env?: Record<string, string>;
}): string {
  const argvXml = opts.argv
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  const envEntries: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    ...opts.env,
  };
  const envXml = Object.entries(envEntries)
    .map(
      ([k, v]) =>
        `        <key>${escapeXml(k)}</key>\n        <string>${escapeXml(v)}</string>`,
    )
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
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${opts.logPath}</string>
    <key>StandardErrorPath</key>
    <string>${opts.logPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
</dict>
</plist>
`;
}
