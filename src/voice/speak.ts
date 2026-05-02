import { spawn } from "node:child_process";

export interface SpeakOptions {
  text: string;
  voice?: string;
  rate?: number;
}

export async function speak(opts: SpeakOptions): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("speak() currently only supports macOS (uses /usr/bin/say)");
  }
  return await new Promise<void>((resolve, reject) => {
    const args: string[] = [];
    if (opts.voice) args.push("-v", opts.voice);
    if (opts.rate) args.push("-r", String(opts.rate));
    args.push(opts.text);
    const child = spawn("/usr/bin/say", args);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`say exited ${code}`)),
    );
  });
}
