import readline from "node:readline";

export interface ReplHandlers {
  onLine: (line: string) => Promise<void>;
  onSlash: (cmd: string, args: string) => Promise<boolean>;
  onClose: () => Promise<void>;
}

const MULTILINE_DELIM = `"""`;

export async function runRepl(handlers: ReplHandlers): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY,
  });
  rl.setPrompt("you> ");
  rl.prompt();

  let buffer: string[] | null = null;

  rl.on("line", async (raw) => {
    if (buffer) {
      if (raw.trim() === MULTILINE_DELIM) {
        const text = buffer.join("\n").trim();
        buffer = null;
        if (text) await processInput(text, handlers, rl);
        rl.prompt();
        return;
      }
      buffer.push(raw);
      return;
    }
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line === MULTILINE_DELIM) {
      buffer = [];
      process.stderr.write(`(multi-line mode — finish with ${MULTILINE_DELIM} on its own line)\n`);
      return;
    }
    await processInput(line, handlers, rl);
    rl.prompt();
  });

  await new Promise<void>((resolve) => rl.on("close", resolve));
  await handlers.onClose();
}

async function processInput(
  line: string,
  handlers: ReplHandlers,
  rl: readline.Interface,
): Promise<void> {
  if (line.startsWith("/")) {
    const space = line.indexOf(" ");
    const cmd = space > 0 ? line.slice(1, space) : line.slice(1);
    const args = space > 0 ? line.slice(space + 1) : "";
    rl.pause();
    try {
      const handled = await handlers.onSlash(cmd, args);
      if (!handled) {
        process.stderr.write(`unknown command: /${cmd}\n`);
      }
    } catch (err) {
      process.stderr.write(`[error] ${(err as Error).message}\n`);
    }
    rl.resume();
    return;
  }
  rl.pause();
  try {
    await handlers.onLine(line);
  } catch (err) {
    process.stderr.write(`[error] ${(err as Error).message}\n`);
  }
  rl.resume();
}
