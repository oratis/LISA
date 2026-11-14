import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCli } from "../../agents/pty.js";
import { buildMacosSeatbeltPolicy } from "../../sandbox/macos.js";
import { sandboxProtections } from "../../sandbox/protect.js";
import type { ClaudeEvents, ClaudeRunner, ClaudeSession } from "./claude.js";
import { FleetError } from "./types.js";

/** Review only the explicitly previewed packet, in an empty temporary workspace.
 * No source checkout, user Codex profile, prior transcript or approval is inherited. */
export function codexInvocation(scratch: string) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--cd",
    scratch,
    "-c",
    'approval_policy="never"',
    "-c",
    'forced_login_method="api"',
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.view_image=false",
    "-c",
    "features.shell_snapshot=false",
    "-c",
    'web_search="disabled"',
    "-c",
    'model_provider="lisa"',
    "-c",
    'model_providers.lisa.name="Fleet OpenAI"',
    "-c",
    "model_providers.lisa.base_url=" +
      JSON.stringify(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    "-c",
    'model_providers.lisa.wire_api="responses"',
    "-c",
    'model_providers.lisa.env_key="CODEX_API_KEY"',
    "-c",
    "model_providers.lisa.supports_websockets=false",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'history.persistence="none"',
    "-",
  ];
}

export class LocalCodex implements ClaudeRunner {
  constructor(
    private readonly home: string,
    private readonly port: number,
  ) {}
  reason(): string | null {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec"))
      return "mac_sandbox_required";
    const binary = resolveCli("codex");
    if (!binary) return "codex_not_installed";
    try {
      const fd = fs.openSync(binary, "r");
      try {
        const magic = Buffer.alloc(4);
        fs.readSync(fd, magic, 0, 4, 0);
        if (
          !["feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(
            magic.toString("hex"),
          )
        )
          return "codex_native_binary_required";
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "codex_not_installed";
    }
    return process.env.OPENAI_API_KEY ? null : "codex_api_key_required";
  }
  start(_cwd: string, events: ClaudeEvents): ClaudeSession {
    const reason = this.reason();
    if (reason) throw new FleetError(503, reason);
    const binary = fs.realpathSync(resolveCli("codex")!);
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-review-")));
    const q = JSON.stringify;
    let policy = buildMacosSeatbeltPolicy({
      cwd: scratch,
      mode: "workspace-write",
      allowNetwork: true,
      denyPaths: [...sandboxProtections().paths, this.home],
      denyTcpPorts: [...sandboxProtections().tcpPorts, this.port],
    });
    policy +=
      '\n(deny file-read-data file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders"))';
    policy += "\n(allow file-read-data file-read* file-write* (subpath " + q(scratch) + "))";
    for (const dir of [scratch, path.dirname(binary)])
      for (let parent = path.dirname(dir); parent !== "/"; parent = path.dirname(parent))
        policy += "\n(allow file-read-data (literal " + q(parent) + "))";
    policy += "\n(allow file-read-data file-read* (literal " + q(binary) + "))";
    // Even checkouts outside /Users and /Volumes stay outside this review's context.
    policy += "\n(deny file-read-data file-write* (subpath " + q(_cwd) + "))";
    const proc = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", policy, binary, ...codexInvocation(scratch)],
      {
        cwd: scratch,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: scratch,
          TMPDIR: scratch,
          CODEX_HOME: scratch,
          CODEX_API_KEY: process.env.OPENAI_API_KEY,
          NO_PROXY: "127.0.0.1,localhost,::1",
          ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
        },
      },
    );
    let sent = false,
      stopped = false,
      complete = false,
      buffer = "",
      result = "",
      failure = "";
    let killTimer: NodeJS.Timeout | undefined;
    const signal = (sig: NodeJS.Signals) => {
      if (proc.pid && proc.exitCode === null && proc.signalCode === null)
        try {
          process.kill(-proc.pid, sig);
        } catch {
          /* already exited */
        }
    };
    const cancel = () => {
      if (stopped) return;
      stopped = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 1500);
      killTimer.unref();
    };
    const fail = (reason: string) => {
      failure = reason;
      cancel();
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      buffer += chunk;
      if (buffer.length > 512 * 1024) {
        fail("codex_protocol_error");
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "item.completed" && msg.item?.type === "agent_message")
            result = String(msg.item.text ?? "").slice(-16000);
          else if (msg.type === "turn.completed") complete = true;
          else if (msg.type === "turn.failed") fail("codex_turn_failed");
          else if (msg.type === "error") failure = "codex_provider_error";
        } catch {
          fail("codex_protocol_error");
          return;
        }
      }
    });
    proc.stderr.resume(); // Provider diagnostics may contain credentials; never relay them.
    proc.stdin.on("error", () => fail("codex_input_closed"));
    proc.on("error", () => {
      failure = "codex_launch_failed";
    });
    proc.once("close", (code) => {
      clearTimeout(killTimer);
      const ok = !stopped && code === 0 && complete && !!result;
      stopped = true;
      try {
        if (ok) events.result(result, false);
        else if (failure) events.result(failure, true);
      } finally {
        try {
          events.exit(ok ? "" : failure || "codex_closed");
        } finally {
          try {
            fs.rmSync(scratch, { recursive: true, force: true });
          } catch {
            /* OS temporary storage */
          }
        }
      }
    });
    return {
      pid: proc.pid,
      send(text) {
        if (sent || stopped) throw new FleetError(409, "append_unavailable");
        sent = true;
        proc.stdin.end(text);
      },
      decide() {
        throw new FleetError(409, "approval_unavailable");
      },
      cancel,
    };
  }
}
