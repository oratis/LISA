/**
 * Quiet-hours catch-up after a restart.
 *
 * A push held back by quiet hours waits in memory (defer.ts) — its text is
 * never written to disk — so a restart during the night would lose it. The
 * ledger, though, still knows THAT something was deferred. On start we look
 * for deferred notices that were never released and send ONE generic push for
 * the lot ("3 updates while you were in quiet hours"): no titles, no bodies,
 * because the process no longer has them and the disk never did. The messages
 * themselves were already delivered in-app when the gate decided.
 *
 * Call once per home at process start, before anything else reaches out.
 */
import { inQuietHours, quietHoursEnd } from "./clock.js";
import { sharedDeferQueue, type DeferQueue } from "./defer.js";
import {
  appendLedger,
  newLedgerId,
  readLedger,
  withReachOutLock,
  type LedgerEntry,
  type LedgerNoticeEntry,
} from "./ledger.js";
import { loadReachOutSettings } from "./settings.js";
import type {
  ReachOutChannel,
  ReachOutSource,
  ReachOutTransports,
  StampedNotice,
} from "./types.js";

/** How far back an unreleased deferral is still worth a catch-up. */
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Deferred notices decided in [now − window, before) with no `release` line.
 * `before` is the process start: anything deferred after it is held by the
 * live queue and releases itself. Pure.
 */
export function pendingDeferred(
  entries: LedgerEntry[],
  now: Date,
  before: Date = now,
  windowMs: number = CATCH_UP_WINDOW_MS,
): LedgerNoticeEntry[] {
  const released = new Set(entries.filter((e) => e.type === "release").map((e) => e.id));
  const since = now.getTime() - windowMs;
  return entries.filter((e): e is LedgerNoticeEntry => {
    if (e.type !== "notice" || e.outcome !== "deferred" || released.has(e.id)) return false;
    const ts = Date.parse(e.ts);
    return ts >= since && ts < before.getTime();
  });
}

function commonest(sources: ReachOutSource[]): ReachOutSource {
  const counts = new Map<ReachOutSource, number>();
  for (const s of sources) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

export interface CatchUpDeps {
  /** The home whose ledger to read. */
  home: string;
  /** The tenant that home belongs to (null = local/operator). */
  uid: string | null;
  transports: Partial<Pick<ReachOutTransports, "push" | "im">>;
  deferQueue?: DeferQueue;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * Queue the catch-up push for `home`, due when quiet hours end (or now, if
 * they already have). Returns how many notices were pending; 0 queues nothing.
 */
export function scheduleQuietHoursCatchUp(deps: CatchUpDeps): number {
  const log = deps.log ?? (() => {});
  const startedAt = (deps.now ?? (() => new Date()))();
  const pending = pendingDeferred(readLedger(deps.home), startedAt);
  if (pending.length === 0) return 0;
  const { quietHours } = loadReachOutSettings(deps.home);
  const id = newLedgerId();

  (deps.deferQueue ?? sharedDeferQueue()).enqueue({
    id,
    dueAt: inQuietHours(startedAt, quietHours)
      ? quietHoursEnd(startedAt, quietHours).getTime()
      : startedAt.getTime(),
    channels: ["push"],
    release: async (at) => {
      // Settings as they are NOW, exactly as the live path treats a held push.
      const latest = loadReachOutSettings(deps.home);
      if (inQuietHours(at, latest.quietHours)) {
        return { retryAt: quietHoursEnd(at, latest.quietHours).getTime() };
      }
      return withReachOutLock(deps.home, async () => {
        const still = pendingDeferred(readLedger(deps.home), at, startedAt);
        const wanted = still.filter(
          (e) =>
            latest.sources[e.source] &&
            latest.dial !== "off" &&
            (e.source !== "desire" || latest.desirePush),
        );
        const released: ReachOutChannel[] = [];
        if (wanted.length > 0) {
          const n = wanted.length;
          const notice: StampedNotice = {
            uid: deps.uid,
            // Decides which device preference the push falls under.
            source: commonest(wanted.map((e) => e.source)),
            kind: "catch-up",
            title: "Lisa",
            body: `${n} update${n === 1 ? "" : "s"} while you were in quiet hours`,
            priority: "normal",
            solicited: true,
            id,
            from: "Lisa",
            ai: true,
            at: at.toISOString(),
          };
          const channels = new Set(wanted.flatMap((e) => e.deferred ?? []));
          for (const channel of ["push", "im"] as const) {
            if (!channels.has(channel) || !latest.channels[channel]) continue;
            try {
              if (channel === "push") await deps.transports.push?.(notice, { silent: false });
              else await deps.transports.im?.(notice);
              released.push(channel);
            } catch (err) {
              log(`[reachout] catch-up ${channel} failed: ${(err as Error).message}`);
            }
          }
        }
        // Mark every one of them released — sent or not — so the next restart
        // does not announce them again.
        await appendLedger(
          still.map((e) => ({
            v: 1 as const,
            type: "release" as const,
            id: e.id,
            ts: at.toISOString(),
            channels: released,
          })),
          deps.home,
          at,
        );
        log(`[reachout] quiet-hours catch-up: ${wanted.length} of ${still.length} held notice(s)`);
        return { released };
      });
    },
  });
  return pending.length;
}
