/**
 * Daily-digest scheduling — pure decision logic. The server polls this on a
 * timer; the actual sweep + push happens in server.ts.
 */
import { localDate } from "./service.js";

export const DEFAULT_DIGEST_HOUR = 8;

/** Target local hour (0-23) for the daily digest; LISA_MAIL_DIGEST_HOUR overrides. */
export function digestHour(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number(env.LISA_MAIL_DIGEST_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_DIGEST_HOUR;
}

/**
 * Is a daily digest due? True when we haven't produced one for the local day yet
 * AND it's at/after the target hour. Pure.
 */
export function isDigestDue(lastDigestDate: string | null, now: Date, targetHour: number): boolean {
  if (lastDigestDate === localDate(now.getTime())) return false;
  return now.getHours() >= targetHour;
}
