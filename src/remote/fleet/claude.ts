import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectClaudeBinary } from "../../agents/pty.js";
import { buildMacosSeatbeltPolicy } from "../../sandbox/macos.js";
import { sandboxProtections } from "../../sandbox/protect.js";
import { FleetError } from "./types.js";

const TOOLS = ["Read", "Edit", "Write"];
const MAX_LINE = 512 * 1024;
export interface Approval {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  expiresAt: number;
}
/** How a permission request ended. `invalid`: allowed too late or after its target changed. */
export type ApprovalOutcome = "allowed" | "denied" | "expired" | "withdrawn" | "invalid";
export interface ClaudeEvents {
  /** A request opens with `request`. It closes with null and the way it ended. */
  approval(request: Approval | null, closed?: { id: string; outcome: ApprovalOutcome }): void;
  /** A tool call that the workspace policy refused without asking anyone. */
  blocked?(tool: string, target: string): void;
  result(text: string, error: boolean): void;
  exit(error: string): void;
}
export interface ClaudeSession {
  send(text: string): void;
  decide(id: string, allow: boolean): void;
  cancel(): void;
}
export interface ClaudeRunner {
  reason(): string | null;
  start(cwd: string, events: ClaudeEvents): ClaudeSession;
}

// Resolve existing ancestors even for a Write creating a new file. Never approve a
// symlink, an administrative file, or a hard link into a different workspace.
function projectFile(cwd: string, value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.split(path.sep).includes("..")
  )
    return false;
  const file = path.resolve(cwd, value);
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith(".." + path.sep) || rel === ".." || path.isAbsolute(rel)) return false;
  let part = cwd;
  for (const component of rel.split(path.sep)) {
    if (component.startsWith(".")) return false;
    part = path.join(part, component);
    try {
      const stat = fs.lstatSync(part);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
        return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

export class LocalClaude implements ClaudeRunner {
  constructor(
    private readonly home: string,
    private readonly port: number,
  ) {}
  reason(): string | null {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec"))
      return "mac_sandbox_required";
    const binary = detectClaudeBinary();
    if (!binary) return "claude_not_installed";
    // An interpreter opens its script again under Seatbelt. This adapter
    // supports the standalone Mac executable shipped with current Claude Code.
    try {
      const fd = fs.openSync(binary, "r");
      try {
        const magic = Buffer.alloc(4);
        fs.readSync(fd, magic, 0, magic.length, 0);
        const nativeHeaders = [
          "feedfacf",
          "cffaedfe",
          "cafebabe",
          "bebafeca",
          "cafebabf",
          "bfbafeca",
        ];
        if (!nativeHeaders.includes(magic.toString("hex"))) return "claude_native_binary_required";
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "claude_not_installed";
    }
    if (!process.env.ANTHROPIC_API_KEY) return "claude_api_key_required";
    return null;
  }
  start(cwd: string, events: ClaudeEvents): ClaudeSession {
    const reason = this.reason();
    if (reason) throw new FleetError(503, reason);
    const binary = fs.realpathSync(detectClaudeBinary()!);
    if (binary.toLowerCase().startsWith(cwd.toLowerCase() + path.sep))
      throw new FleetError(400, "claude_binary_inside_project");
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-agent-")));
    let policy = buildMacosSeatbeltPolicy({
      cwd,
      mode: "workspace-write",
      allowNetwork: true,
      denyPaths: [...sandboxProtections().paths, this.home],
      denyTcpPorts: [...sandboxProtections().tcpPorts, this.port],
    });
    // The general shell profile allows shared temporary writes and reads from the
    // rest of the user's home. Bare Claude needs its executable, runtime files,
    // its own scratch space and the selected checkout only.
    const q = JSON.stringify;
    policy +=
      '\n(deny file-read-data file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))';
    policy +=
      "\n(allow file-read* file-write* (subpath " + q(cwd) + ") (subpath " + q(scratch) + "))";
    // Bun opens the temporary directory ancestors at startup. Grant directory
    // nodes individually, without granting access to files beneath them.
    for (const directory of [scratch, cwd, path.dirname(binary)])
      for (let parent = path.dirname(directory); parent !== "/"; parent = path.dirname(parent))
        policy += "\n(allow file-read-data (literal " + q(parent) + "))";
    policy += "\n(allow file-read* (literal " + q(binary) + "))";
    for (const dir of [
      fs.realpathSync(this.home),
      ...sandboxProtections().paths,
      path.join(cwd, ".git"),
      path.join(cwd, ".claude"),
    ])
      policy += "\n(deny file-read-data file-write* (subpath " + q(dir) + "))";
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      TMPDIR: scratch,
      CLAUDE_CONFIG_DIR: scratch,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    const args = [
      "-p",
      "--bare",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "default",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--tools",
      TOOLS.join(","),
      "--settings",
      JSON.stringify({ disableAllHooks: true, permissions: { ask: TOOLS } }),
    ];
    const proc = spawn("/usr/bin/sandbox-exec", ["-p", policy, binary, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let pending: { request: Approval; cliId: string } | undefined;
    let buffer = "",
      stopped = false,
      failure = "";
    let approvalTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const signal = (sig: NodeJS.Signals) => {
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        try {
          process.kill(-proc.pid, sig);
        } catch {
          /* group already exited */
        }
      }
    };
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 1500);
      killTimer.unref();
    };
    const write = (value: unknown) => {
      if (stopped || !proc.stdin.writable || proc.stdin.writableLength > MAX_LINE)
        throw new FleetError(409, "process_unavailable");
      proc.stdin.write(JSON.stringify(value) + "\n");
    };
    const response = (id: string, allow: boolean, input: unknown) =>
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: id,
          response: allow
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Denied by workspace policy or owner" },
        },
      });
    const settle = (id: string, allow: boolean, expired = false) => {
      if (!pending || pending.request.id !== id) throw new FleetError(409, "stale_approval");
      const { request, cliId } = pending;
      const valid = Date.now() < request.expiresAt && projectFile(cwd, request.input.file_path);
      response(cliId, allow && valid, request.input);
      pending = undefined;
      clearTimeout(approvalTimer);
      events.approval(null, {
        id,
        outcome: expired ? "expired" : !allow ? "denied" : valid ? "allowed" : "invalid",
      });
      if (allow && !valid) throw new FleetError(409, "approval_expired_or_path_changed");
    };
    const decide = (id: string, allow: boolean) => settle(id, allow);
    const protocolError = () => {
      failure = "claude_protocol_error";
      cancel();
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end > MAX_LINE || (end < 0 && buffer.length > MAX_LINE)) {
          protocolError();
          return;
        }
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim() || stopped) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "control_request") {
            const r = msg.request;
            if (!r || typeof msg.request_id !== "string") throw Error();
            if (
              r.subtype !== "can_use_tool" ||
              !TOOLS.includes(r.tool_name) ||
              pending ||
              !projectFile(cwd, r.input?.file_path) ||
              JSON.stringify(r.input).length > 16384
            ) {
              response(msg.request_id, false, {});
              if (r.subtype === "can_use_tool")
                events.blocked?.(
                  String(r.tool_name).slice(0, 64),
                  typeof r.input?.file_path === "string" ? r.input.file_path.slice(0, 512) : "",
                );
              continue;
            }
            const request: Approval = {
              id: crypto.randomUUID(),
              tool: r.tool_name,
              input: r.input,
              expiresAt: Date.now() + 300_000,
            };
            pending = { request, cliId: msg.request_id };
            events.approval(request);
            approvalTimer = setTimeout(() => {
              try {
                settle(request.id, false, true);
              } catch {
                protocolError();
              }
            }, 300_000);
            approvalTimer.unref();
          } else if (
            msg.type === "control_cancel_request" &&
            pending &&
            pending.cliId === msg.request_id
          ) {
            const id = pending.request.id;
            pending = undefined;
            clearTimeout(approvalTimer);
            events.approval(null, { id, outcome: "withdrawn" });
          } else if (msg.type === "result") {
            events.result(
              typeof msg.result === "string"
                ? msg.result.slice(-16000)
                : String(msg.subtype || "No result"),
              msg.is_error === true || msg.subtype !== "success",
            );
          }
        } catch {
          protocolError();
          return;
        }
      }
    });
    // Do not put provider diagnostics or raw credentials in the control-plane log.
    proc.stderr.resume();
    proc.stdin.on("error", () => {
      failure = "claude_input_closed";
      cancel();
    });
    proc.on("error", () => {
      failure = "claude_launch_failed";
    });
    proc.once("close", (code) => {
      stopped = true;
      clearTimeout(approvalTimer);
      clearTimeout(killTimer);
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* OS-managed temporary directory */
      }
      events.exit(failure || (code === 0 ? "" : "claude_exited"));
    });
    return {
      send(text) {
        write({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
          session_id: "",
        });
      },
      decide,
      cancel,
    };
  }
}
