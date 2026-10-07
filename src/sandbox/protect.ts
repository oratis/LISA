/**
 * Resources a sandboxed command must never reach, whatever the mode grants.
 *
 * A confined shell is `auto` under Warden, so it must not be able to talk to
 * the thing that decides what is `auto`: Warden's state directory (rules,
 * grants, audit, the digest key) and the LISA server's own listening port
 * (the approval API trusts a loopback peer). Both are denied in every bounded
 * sandbox profile, after — and so overriding — the mode's allow rules.
 */
import fs from "node:fs";
import path from "node:path";
import { lisaGlobalHome } from "../paths.js";

/** The port `lisa serve --web` binds when none is given. */
const DEFAULT_LISA_PORT = 5757;

const registeredPorts = new Set<number>();
const registeredPaths = new Set<string>();

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536;
}

/** Register a port or path that sandboxed commands may not reach (idempotent). */
export function protectFromSandbox(resource: { port?: number; path?: string }): void {
  if (validPort(resource.port)) registeredPorts.add(resource.port);
  if (resource.path && path.isAbsolute(resource.path)) registeredPaths.add(resource.path);
}

/** A path plus its symlink-resolved form (seatbelt matches the resolved one). */
function withRealPath(p: string): string[] {
  const out = new Set<string>([p]);
  let current = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      out.add(path.join(fs.realpathSync.native(current), ...tail));
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return [...out];
}

export interface SandboxProtections {
  /** Absolute directories: no read, no write. */
  paths: string[];
  /** TCP ports: no outbound connection, on any host. */
  tcpPorts: number[];
}

/** Everything a bounded sandbox profile must deny right now. */
export function sandboxProtections(env: NodeJS.ProcessEnv = process.env): SandboxProtections {
  const paths = new Set<string>();
  for (const p of [path.join(lisaGlobalHome(), "warden"), ...registeredPaths]) {
    for (const variant of withRealPath(p)) paths.add(variant);
  }
  const ports = new Set<number>([DEFAULT_LISA_PORT, ...registeredPorts]);
  const fromEnv = Number(env.LISA_PORT);
  if (validPort(fromEnv)) ports.add(fromEnv);
  return { paths: [...paths], tcpPorts: [...ports].sort((a, b) => a - b) };
}

/** Test hook. */
export function _resetSandboxProtectionsForTest(): void {
  registeredPorts.clear();
  registeredPaths.clear();
}
