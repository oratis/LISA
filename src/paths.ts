import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Home resolution — the multi-tenant seam (PLAN_ACCOUNTS_BILLING B2 / C3).
 *
 * Two homes exist on purpose:
 *  - `lisaGlobalHome()` — the operator/process home. Config + provider keys
 *    (config.env), the account directory (accounts.json), device tokens, the
 *    session secret. NEVER per-user.
 *  - `lisaHome()` — the ACTIVE home for identity-bearing state (soul, sessions,
 *    memory, reflections, autonomy, kb…). On the Mac edition it equals the
 *    global home. On the cloud edition, a signed-in request runs inside
 *    `homeScope.run(homeForUid(uid), …)` and everything downstream — including
 *    awaited work — reads that user's subtree instead.
 *
 * Paths are FUNCTIONS, not import-time constants: a constant freezes the home
 * at module load, which is exactly what made the codebase single-tenant.
 */
export const homeScope = new AsyncLocalStorage<string>();

/** The operator/process home (config, keys, accounts, devices). Never per-uid. */
export function lisaGlobalHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}

/** The active home — per-uid inside a cloud request scope, else the global home. */
export function lisaHome(): string {
  return homeScope.getStore() ?? lisaGlobalHome();
}

/** A user's home subtree. uid comes from the account store (server-minted). */
export function homeForUid(uid: string): string {
  return path.join(lisaGlobalHome(), "users", uid);
}

export function skillsDir(): string {
  return path.join(lisaHome(), "skills");
}
export function memoryDir(): string {
  return path.join(lisaHome(), "memory");
}
export function sessionsDir(): string {
  return path.join(lisaHome(), "sessions");
}
export function reflectionsDir(): string {
  return path.join(lisaHome(), "reflections");
}
export function memoryFile(): string {
  return path.join(memoryDir(), "MEMORY.md");
}
export function userFile(): string {
  return path.join(memoryDir(), "USER.md");
}
