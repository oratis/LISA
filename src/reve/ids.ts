import { randomBytes } from "node:crypto";

let lastMs = 0;

/**
 * Mint a dream id: `d-<yyyymmddThhmmssSSS>-<hex8>` (UTC, millisecond stamp).
 * Lexicographic order == time order; within one process the stamp is made
 * strictly increasing (a second id in the same millisecond takes the next
 * one), so "newest first" listings are stable.
 */
export function newDreamId(now: Date = new Date()): string {
  let ms = now.getTime();
  if (ms <= lastMs) ms = lastMs + 1;
  lastMs = ms;
  const iso = new Date(ms).toISOString(); // 2026-10-09T12:34:56.789Z
  const stamp =
    `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}` +
    `T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}`;
  return `d-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Mint a reconsider request id. */
export function newReconsiderId(): string {
  return `rc-${randomBytes(6).toString("hex")}`;
}
