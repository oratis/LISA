import path from "node:path";
import { lisaHome } from "../paths.js";

/** `<lisaHome>/reve` — per-uid inside a cloud request scope. */
export function reveDir(): string {
  return path.join(lisaHome(), "reve");
}

export function dreamsDir(): string {
  return path.join(reveDir(), "dreams");
}

/** Dream ids are server-minted: `d-<yyyymmddThhmmssSSS>-<hex8>` (UTC, ms). */
const DREAM_ID_RE = /^d-\d{8}T\d{9}-[0-9a-f]{8}$/;

export function isValidDreamId(id: unknown): id is string {
  return typeof id === "string" && DREAM_ID_RE.test(id);
}

function assertDreamId(id: string): string {
  if (!isValidDreamId(id)) throw new Error(`invalid dream id: ${String(id).slice(0, 40)}`);
  return id;
}

export function dreamFile(id: string): string {
  return path.join(dreamsDir(), `${assertDreamId(id)}.json`);
}

export function dreamSummaryFile(id: string): string {
  return path.join(dreamsDir(), `${assertDreamId(id)}.md`);
}

/** Pre-pass content of user-owned files, needed for revert. */
export function dreamSnapshotFile(id: string): string {
  return path.join(dreamsDir(), `${assertDreamId(id)}.before.json`);
}

export function reconsiderFile(): string {
  return path.join(reveDir(), "reconsider.json");
}

export function reveLockPath(): string {
  return path.join(reveDir(), ".write.lock");
}

export function reveAuditFile(): string {
  return path.join(reveDir(), "audit.jsonl");
}
