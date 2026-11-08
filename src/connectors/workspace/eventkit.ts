import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withFileLock } from "../../soul/lock.js";
import { lisaHome } from "../../paths.js";
import { fail } from "./http.js";
import type { Period } from "./data.js";

const exec = promisify(execFile);
const nativeEnv = { PATH: "/usr/bin:/bin", HOME: os.homedir(), TMPDIR: os.tmpdir() };
async function built(binary: string) {
  try {
    await fs.access(binary, fs.constants.X_OK);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
const source = fileURLToPath(new URL("../../../packaging/eventkit/Reader.swift", import.meta.url));
const plist = fileURLToPath(new URL("../../../packaging/eventkit/Info.plist", import.meta.url));
async function executable(signal: AbortSignal) {
  const hash = createHash("sha256")
    .update(await fs.readFile(source))
    .update(await fs.readFile(plist))
    .digest("hex")
    .slice(0, 20);
  const dir = path.join(lisaHome(), "connectors", "eventkit-bin");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const binary = path.join(dir, "reader-" + process.arch + "-" + hash);
  if (await built(binary)) return binary;
  return withFileLock(
    binary + ".lock",
    async () => {
      if (await built(binary)) return binary;
      const stage = await fs.mkdtemp(path.join(dir, "build-"));
      try {
        const output = path.join(stage, "reader");
        await exec(
          "/usr/bin/xcrun",
          [
            "swiftc",
            "-parse-as-library",
            "-target",
            (process.arch === "arm64" ? "arm64" : "x86_64") + "-apple-macos14.0",
            source,
            "-o",
            output,
            "-Xlinker",
            "-sectcreate",
            "-Xlinker",
            "__TEXT",
            "-Xlinker",
            "__info_plist",
            "-Xlinker",
            plist,
          ],
          { env: nativeEnv, signal, timeout: 90000 },
        );
        await exec(
          "/usr/bin/codesign",
          ["--force", "--sign", "-", "--identifier", "ai.meetlisa.connectors.eventkit", output],
          { env: nativeEnv, signal, timeout: 20000 },
        );
        await fs.rename(output, binary);
        return binary;
      } catch {
        fail("workspace_eventkit_build");
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    },
    { signal, staleMs: 150000, timeoutMs: 120000 },
  );
}
export type NativeBridge = (
  entity: "events" | "reminders",
  action: string,
  key: string,
  signal: AbortSignal,
  period?: Period,
) => Promise<unknown>;
export const eventKit: NativeBridge = async (entity, action, key, signal, period) => {
  if (process.platform !== "darwin" || parseInt(os.release()) < 23)
    fail("workspace_eventkit_platform");
  const bin = await executable(signal);
  try {
    const { stdout } = await exec(
      bin,
      [entity, action, key, period?.from ?? "", period?.to ?? ""],
      {
        env: nativeEnv,
        signal,
        timeout: action === "authorize" ? 120000 : 30000,
        maxBuffer: 1_000_000,
      },
    );
    return JSON.parse(stdout);
  } catch {
    fail(signal.aborted ? "request_cancelled" : "workspace_eventkit_access");
  }
};
