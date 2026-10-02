import { spawn } from "node:child_process";

export interface SpeakOptions {
  text: string;
  voice?: string;
  rate?: number;
}

/**
 * argv for /usr/bin/say. The text goes after `--`: without it, text starting
 * with "-" is parsed as an option, and `-o<path>` makes say write a file.
 */
export function sayArgs(opts: SpeakOptions): string[] {
  const args: string[] = [];
  if (opts.voice) args.push("-v", opts.voice);
  if (opts.rate) args.push("-r", String(opts.rate));
  args.push("--", opts.text);
  return args;
}

export async function speak(opts: SpeakOptions): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("speak() currently only supports macOS (uses /usr/bin/say)");
  }
  return await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/say", sayArgs(opts));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`say exited ${code}`)),
    );
  });
}
