/**
 * Claude session liveness — which on-disk claude sessions are CURRENTLY running.
 *
 * Claude Code writes ~/.claude/sessions/<pid>.json for each running session:
 *   {"pid":43828,"sessionId":"f859…","cwd":"…","version":"2.1.177",
 *    "peerProtocol":1,"kind":"interactive","entrypoint":"claude-desktop"}
 *
 * We use it for one purpose: deciding whether a session is safe to ADOPT via
 * `claude --resume <id>`. Resuming a session that's still live (open in the app
 * or a terminal) would create a second writer to the same JSONL transcript and
 * interleave/corrupt it — so the control plane only ever resumes IDLE sessions.
 * (We never speak the undocumented peerProtocol; we only read pid + sessionId.)
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeSessionsDir(home: string = homedir()): string {
  return join(home, ".claude", "sessions");
}

/** True if a pid is still running (EPERM = alive but not ours; ESRCH = gone). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * sessionIds whose owning process is still alive — i.e. currently driven by the
 * app/terminal and therefore UNSAFE to resume. Best-effort: unreadable or stale
 * pid-files are skipped. Returns an empty set if the directory is absent.
 */
export function liveClaudeSessionIds(home: string = homedir()): Set<string> {
  const live = new Set<string>();
  const dir = claudeSessionsDir(home);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return live;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      if (typeof meta.sessionId === "string" && typeof meta.pid === "number" && pidAlive(meta.pid)) {
        live.add(meta.sessionId);
      }
    } catch {
      /* skip garbage / partial writes */
    }
  }
  return live;
}
