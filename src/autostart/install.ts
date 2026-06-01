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
import { LISA_HOME } from "../paths.js";
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
const AUTOSTART_LOG = path.join(LISA_HOME, "autostart.log");

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
      logPath: AUTOSTART_LOG,
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
        `  log:   ${AUTOSTART_LOG}`,
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
    `  log: ${AUTOSTART_LOG}`,
  ].join("\n");
}

/** Render the macOS LaunchAgent plist. Exported for testing. */
export function renderPlist(opts: {
  label: string;
  argv: string[];
  logPath: string;
}): string {
  const argvXml = opts.argv
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
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
`;
}
