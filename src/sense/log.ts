/**
 * Sense event log (PLAN_SENSE S2 + FOUNDATIONS §4 observability) — a bounded,
 * retention-capped JSONL of distilled SenseEvents at ~/.lisa/sense/events.jsonl.
 *
 * Only STRUCTURED events land here (the sources already redact/skip); raw bytes
 * never reach this file. Bounded by a max-line cap AND a retention window so it
 * can't grow without limit and stale context ages out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isExpired } from "../consent/store.js";
import type { SenseEvent } from "./types.js";

const MAX_EVENTS = 1000;
const DEFAULT_RETENTION_DAYS = 7;

function lisaHome(): string {
  return process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");
}
function logPath(): string {
  return path.join(lisaHome(), "sense", "events.jsonl");
}

/** Read all valid, non-expired events (oldest → newest). Tolerant of junk. */
export function readSenseEvents(
  now: number = Date.now(),
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): SenseEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }
  const out: SenseEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SenseEvent;
      if (e && typeof e.signal === "string" && typeof e.ts === "number" && !isExpired(e.ts, retentionDays, now)) {
        out.push(e);
      }
    } catch {
      // skip a corrupt line
    }
  }
  return out;
}

/**
 * Append one event, then keep the file bounded: drop expired events and cap to
 * the most recent MAX_EVENTS. Best-effort — never throws into the caller.
 */
export function appendSenseEvent(
  e: SenseEvent,
  now: number = Date.now(),
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): void {
  try {
    const existing = readSenseEvents(now, retentionDays);
    existing.push(e);
    const kept = existing.slice(-MAX_EVENTS);
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, kept.map((x) => JSON.stringify(x)).join("\n") + "\n");
  } catch {
    // disk unavailable — drop the event rather than crash the sense loop
  }
}
