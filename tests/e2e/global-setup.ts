/**
 * Builds dist/ once for the whole run.
 *
 * The specs drive `node dist/cli.js serve --web`, i.e. the shipped artefact
 * rather than a dev loader — a smoke test that passes against tsx but not
 * against dist/ is worth nothing. Each spec file then starts its own instance
 * (see helpers/lisa-server.ts): they need different LISA_HOMEs — no soul + no
 * key for the gate, a fabricated soul for the shell, an empty home plus a
 * failing stub for the birth path — so a single shared server cannot serve
 * them all.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import fs from "node:fs/promises";
import { REPO_ROOT } from "./helpers/lisa-server.js";

export default async function globalSetup(): Promise<void> {
  await fs
    .rm(path.join(REPO_ROOT, ".tmp", "e2e"), { recursive: true, force: true })
    .catch(() => {});

  if (process.env.LISA_E2E_SKIP_BUILD === "1") return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`npm run build exited ${code}`)),
    );
  });

  // Fail here rather than in a spec, where the message is buried in a timeout.
  await fs.access(path.join(REPO_ROOT, "dist", "cli.js"));
}
