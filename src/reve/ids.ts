import { randomBytes } from "node:crypto";

/** Mint a dream id: `d-<yyyymmddThhmmss>-<hex8>` (UTC). Sortable by time. */
export function newDreamId(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-10-09T12:34:56.789Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `d-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Mint a reconsider request id. */
export function newReconsiderId(): string {
  return `rc-${randomBytes(6).toString("hex")}`;
}
