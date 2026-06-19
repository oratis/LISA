/**
 * `lisa agents pty <agent> <task…>`        — adopt-at-launch (iOS plan §4.1), and
 * `lisa agents pty --resume <session-id>`  — adopt an IDLE claude session (§4.2).
 *
 * Closes the "control a session LISA didn't start" gap the honest way: instead of
 * trying to attach to a `claude`/`codex` you already opened (which needs Claude
 * Code's undocumented peerProtocol), you start one *through* LISA. This is a thin
 * client to the already-running `lisa serve --web`: it asks the server to spawn a
 * real CLI under a PTY (POST /api/agents/pty/start), so the session is born
 * `controllable:"pty"` — it shows up in the roster (island / GUI / phone) and can
 * be steered remotely — then mirrors its output here and forwards your typed lines.
 *
 * Requires the server to run with LISA_PTY_AGENTS=1 (+ `npm i node-pty`); otherwise
 * the start endpoint 503s and we print the hint.
 *
 * LIMITATION (v1): input is line-oriented (each line you type → one line into the
 * CLI), not a raw keystroke passthrough — great for task-style runs, not for
 * driving a full arrow-key TUI. Raw attach is future work.
 */
import readline from "node:readline";

const DEFAULT_PORT = 5757;

export interface PtyArgs {
  agent: string;
  task: string;
  port: number;
  /** Adopt an idle claude session via `claude --resume <id>` (claude-only). */
  resumeSessionId?: string;
}

const USAGE =
  "usage: lisa agents pty [--port N] <agent> <task…>                      # new agent (agent = claude | codex)\n" +
  "       lisa agents pty [--port N] --resume <session-id> [follow-up…]   # adopt an IDLE claude session";

/** Parse the `lisa agents pty` argv. Pure (no I/O). */
export function parsePtyArgs(argv: string[]): PtyArgs | { error: string } {
  let port = Number(process.env.LISA_WEB_PORT) || DEFAULT_PORT;
  let resumeSessionId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") {
      const v = argv[++i];
      if (!v) return { error: USAGE };
      port = Number(v);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice("--port=".length));
    } else if (a === "--resume") {
      const v = argv[++i];
      if (!v) return { error: "--resume needs a <session-id> (from the roster's adoptable list)" };
      resumeSessionId = v;
    } else if (a.startsWith("--resume=")) {
      resumeSessionId = a.slice("--resume=".length);
    } else {
      rest.push(a);
    }
  }
  if (!Number.isInteger(port) || port <= 0) return { error: "--port must be a positive integer" };
  // Adopt mode: claude-only; the remaining words are an OPTIONAL follow-up (empty = pure continuation).
  if (resumeSessionId) {
    return { agent: "claude", task: rest.join(" ").trim(), port, resumeSessionId };
  }
  const agent = rest.shift();
  if (!agent) return { error: USAGE };
  const task = rest.join(" ").trim();
  if (!task) return { error: `a task is required: lisa agents pty ${agent} "<what to do>"` };
  return { agent, task, port };
}

/** Extract complete SSE `data:` payloads from a buffer; return them + the leftover. Pure. */
export function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let idx: number;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(l.startsWith("data: ") ? 6 : 5))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest: buffer };
}

async function streamOutput(base: string, id: string): Promise<void> {
  const res = await fetch(`${base}/api/agents/pty/${encodeURIComponent(id)}/stream`);
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = parseSseEvents(buf);
    buf = rest;
    for (const data of events) {
      try {
        const msg = JSON.parse(data) as { type?: string; text?: string };
        if (typeof msg.text === "string") process.stdout.write(msg.text);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

export async function runAgentPtyAttach(argv: string[]): Promise<number> {
  const parsed = parsePtyArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const { agent, task, port, resumeSessionId } = parsed;
  const base = `http://127.0.0.1:${port}`;

  let startRes: Response;
  try {
    startRes = await fetch(`${base}/api/agents/pty/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, task, cwd: process.cwd(), ...(resumeSessionId ? { resumeSessionId } : {}) }),
    });
  } catch (err) {
    console.error(
      `Could not reach LISA at ${base} — is \`lisa serve --web\` running? (${(err as Error).message})`,
    );
    return 1;
  }
  if (startRes.status === 503) {
    const msg = (await startRes.text().catch(() => "")).trim();
    console.error(
      `PTY agents are off. ${msg || "Start serve with LISA_PTY_AGENTS=1 and run `npm i node-pty`."}`,
    );
    return 1;
  }
  if (startRes.status === 409) {
    // resume guard: the session is still live (open in the app/terminal).
    console.error(
      `Can't adopt that session: ${(await startRes.text().catch(() => "")).trim() || "it's currently live — close it first."}`,
    );
    return 1;
  }
  if (!startRes.ok) {
    console.error(`start failed (${startRes.status}): ${(await startRes.text().catch(() => "")).trim()}`);
    return 1;
  }

  const body = (await startRes.json()) as {
    agent?: { id: string; agent: string; cli: string; cwd: string };
  };
  const view = body.agent;
  if (!view?.id) {
    console.error("start returned no agent id");
    return 1;
  }
  const id = view.id;
  console.error(
    resumeSessionId
      ? `▶ resumed claude session ${resumeSessionId} (${view.cli}) under LISA — id ${id}`
      : `▶ ${view.agent} (${view.cli}) under LISA — id ${id}`,
  );
  console.error("  Controllable from the roster / phone. Type a line to send it; Ctrl-C stops the agent.\n");

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void fetch(`${base}/api/agents/pty/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: line }),
    }).catch(() => {});
  });

  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    await fetch(`${base}/api/agents/pty/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => {});
  };
  process.on("SIGINT", () => {
    void cancel().then(() => process.exit(130));
  });

  try {
    await streamOutput(base, id);
  } catch (err) {
    console.error(`\n[attach ended: ${(err as Error).message}]`);
  }
  rl.close();
  return 0;
}
