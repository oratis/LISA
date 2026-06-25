/**
 * Mail persistence: the latest/dated digests + per-account seen-UID tracking
 * (for incremental sweeps and alert dedup). All under ~/.lisa/mail/, mode 0600.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DailyDigest } from "./types.js";

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
function mailDir(): string {
  return path.join(lisaHome(), "mail");
}
function ensure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ── digests ──

export function saveDigest(d: DailyDigest): void {
  const dir = path.join(mailDir(), "digests");
  ensure(dir);
  fs.writeFileSync(path.join(dir, `${d.date}.json`), JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(mailDir(), "latest-digest.json"), JSON.stringify(d, null, 2), { mode: 0o600 });
}

export function latestDigest(): DailyDigest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(mailDir(), "latest-digest.json"), "utf8")) as DailyDigest;
  } catch {
    return null;
  }
}

// ── seen UIDs (dedup) ──

const SEEN_CAP = 5000;

function seenPath(accountId: string): string {
  return path.join(mailDir(), "seen", `${accountId}.json`);
}

export function loadSeen(accountId: string): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(seenPath(accountId), "utf8")) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/** Record uids as seen; keeps the most recent SEEN_CAP. */
export function markSeen(accountId: string, uids: string[]): void {
  if (uids.length === 0) return;
  const dir = path.join(mailDir(), "seen");
  ensure(dir);
  const existing = loadSeen(accountId);
  for (const u of uids) existing.add(u);
  const trimmed = [...existing].slice(-SEEN_CAP);
  fs.writeFileSync(seenPath(accountId), JSON.stringify(trimmed), { mode: 0o600 });
}
