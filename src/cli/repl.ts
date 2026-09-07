/**
 * The interactive `lisa` prompt.
 *
 * Two things beyond a bare readline loop:
 *   - **Persistent history.** readline keeps history in memory only, so every
 *     session used to start with an empty ↑. History is loaded from
 *     `~/.lisa/history` at start and written back on close (see ./history.ts
 *     for the file format and the 0600 reasoning).
 *   - **Injectable streams.** stdin/stderr are parameters, not globals, so the
 *     loop can be driven by a test with a pair of PassThroughs instead of a
 *     terminal.
 *
 * Everything the REPL itself says (prompt, errors, mode hints) goes to the
 * output stream — stderr in production — because stdout is reserved for Lisa's
 * words so `lisa … | …` keeps working.
 */
import readline from "node:readline";
import { HISTORY_LIMIT, historyPath, loadHistory, saveHistory } from "./history.js";

export interface ReplHandlers {
  onLine: (line: string) => Promise<void>;
  onSlash: (cmd: string, args: string) => Promise<boolean>;
  onClose: () => Promise<void>;
}

export interface ReplOptions {
  input?: NodeJS.ReadableStream;
  /** Where the prompt and REPL-level messages go. Defaults to stderr. */
  output?: NodeJS.WritableStream;
  /** Enable readline line editing. Defaults to "input is a TTY". */
  terminal?: boolean;
  /** History file; `null` disables persistence (used by tests). */
  historyFile?: string | null;
  prompt?: string;
}

const MULTILINE_DELIM = `"""`;

export async function runRepl(handlers: ReplHandlers, options: ReplOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const out = options.output ?? process.stderr;
  const terminal = options.terminal ?? (input as NodeJS.ReadStream).isTTY === true;
  const historyFile = options.historyFile === undefined ? historyPath() : options.historyFile;

  // Only a terminal session has history: piped stdin has no ↑ to press, and a
  // scripted `lisa < script.txt` must not pollute the user's history file.
  const persist = historyFile != null && terminal;
  // The file is oldest-first (append-shaped); readline wants newest-first.
  const loaded = persist ? await loadHistory(historyFile) : [];

  const rl = readline.createInterface({
    input,
    output: out,
    terminal,
    history: loaded.slice().reverse(),
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
  });
  rl.setPrompt(options.prompt ?? "you> ");
  rl.prompt();

  let buffer: string[] | null = null;
  let closed = false;
  // Handlers are async and `line` events are not: without a queue, a second
  // line typed (or piped) while a turn is running would run its handler
  // concurrently and interleave with the first. Chaining also gives close a
  // single thing to await before it saves history.
  let pending: Promise<void> = Promise.resolve();

  const handleLine = async (raw: string): Promise<void> => {
    if (buffer) {
      if (raw.trim() === MULTILINE_DELIM) {
        const text = buffer.join("\n").trim();
        buffer = null;
        if (text) await processInput(text, handlers, rl, out);
        reprompt();
        return;
      }
      buffer.push(raw);
      return;
    }
    const line = raw.trim();
    if (!line) {
      reprompt();
      return;
    }
    if (line === MULTILINE_DELIM) {
      buffer = [];
      out.write(`(multi-line mode — finish with ${MULTILINE_DELIM} on its own line)\n`);
      return;
    }
    await processInput(line, handlers, rl, out);
    reprompt();
  };

  /** Ctrl-D (or an ended stdin) can land mid-turn; readline throws if touched after. */
  function reprompt(): void {
    if (!closed) rl.prompt();
  }

  rl.on("line", (raw) => {
    pending = pending
      .then(() => handleLine(raw))
      .catch((err) => {
        out.write(`[error] ${(err as Error).message}\n`);
      });
  });

  await new Promise<void>((resolve) =>
    rl.on("close", () => {
      closed = true;
      resolve();
    }),
  );
  // The last prompt may still be running when stdin ends — finish it before
  // reflection and history are written.
  await pending;

  if (persist) {
    try {
      // rl.history is newest-first; the file is oldest-first.
      const lines = ((rl as unknown as { history?: string[] }).history ?? []).slice().reverse();
      await saveHistory(lines, historyFile);
    } catch {
      // A history file we cannot write is never worth failing a session over.
    }
  }

  await handlers.onClose();
}

async function processInput(
  line: string,
  handlers: ReplHandlers,
  rl: readline.Interface,
  out: NodeJS.WritableStream,
): Promise<void> {
  if (line.startsWith("/")) {
    const space = line.indexOf(" ");
    const cmd = space > 0 ? line.slice(1, space) : line.slice(1);
    const args = space > 0 ? line.slice(space + 1) : "";
    rl.pause();
    try {
      const handled = await handlers.onSlash(cmd, args);
      if (!handled) {
        out.write(`unknown command: /${cmd}\n`);
      }
    } catch (err) {
      out.write(`[error] ${(err as Error).message}\n`);
    }
    resume(rl);
    return;
  }
  rl.pause();
  try {
    await handlers.onLine(line);
  } catch (err) {
    out.write(`[error] ${(err as Error).message}\n`);
  }
  resume(rl);
}

/** readline throws ERR_USE_AFTER_CLOSE if stdin ended while the turn ran. */
function resume(rl: readline.Interface): void {
  if ((rl as unknown as { closed?: boolean }).closed) return;
  rl.resume();
}
