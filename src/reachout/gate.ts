/**
 * The reach-out gate — docs/POLICY_REACH_OUT.md in code.
 *
 * `decideReachOut` is the pure rule; `reachOut` wraps it with the tenant's
 * settings, the ledger (budget, dedupe, feedback) and delivery. The order of
 * the rules is the charter's order of precedence:
 *
 *   1. Red lines                    → denied on every channel, logged.
 *   2. Duplicate (`dedupeKey`)      → dropped.
 *   3. `approval` / `critical`      → always delivered, in-app + push, even in
 *                                     quiet hours (the push goes out silent).
 *   4. Source switched off          → dropped.
 *   5. Dial "off"                   → in-app only.
 *   6. Solicited (the user's own task / routine / watcher, or a scheduled
 *      item they switched on: the mail digest, the daily brief)
 *                                   → no budget, no value gate; quiet hours
 *                                     defer the push.
 *   7. Unsolicited                  → `desire` stays in-app unless opted in;
 *                                     then the value gate; then the daily
 *                                     budget (notices sharing a `budgetKey`
 *                                     spend one unit between them); then
 *                                     quiet hours defer the push.
 *
 * In-app delivery is the baseline: rules 5–7 only ever take the interrupting
 * channels (push, IM) away. The gate never throws to a sender.
 */
import { relevanceScore } from "../advisor/engine.js";
import { getAutonomyEnabled } from "../autonomy/state.js";
import { homeForUid, homeScope, lisaHome, scopedUid } from "../paths.js";
import { inQuietHours, localMoment, quietHoursEnd } from "./clock.js";
import { DeferQueue, sharedDeferQueue } from "./defer.js";
import {
  appendLedger,
  budgetShare,
  budgetUsed,
  netDismissals,
  newLedgerId,
  noticeEntry,
  readLedger,
  seenRecently,
  withReachOutLock,
} from "./ledger.js";
import { redLineFor } from "./redlines.js";
import { DAILY_BUDGET, loadReachOutSettings, type ReachOutSettings } from "./settings.js";
import type {
  ReachOutChannel,
  ReachOutDecision,
  ReachOutDial,
  ReachOutNotice,
  ReachOutResult,
  ReachOutSource,
  ReachOutTransports,
  StampedNotice,
} from "./types.js";

/**
 * Value bar for unsolicited notices, on the advisor's scale
 * (urgency × actionability × dismissal decay). 1.0 is what a normal-priority,
 * non-actionable notice scores before anyone has dismissed its kind — so each
 * existing sender clears it out of the box, a low-priority aside does not, and
 * dismissals push a kind below it.
 */
export const VALUE_BAR = 1.0;

const URGENCY_FOR = { low: "info", normal: "notice", high: "urgent", critical: "urgent" } as const;

/** Sources that are the user's own request by nature (charter §2). */
const SOLICITED_BY_NATURE: ReadonlySet<ReachOutSource> = new Set<ReachOutSource>([
  "task",
  "watcher",
]);
/** Sources that only exist because Lisa ran unattended (the "Proactive mode" switch). */
const AUTONOMY_BORN: ReadonlySet<ReachOutSource> = new Set<ReachOutSource>(["idle", "desire"]);

export function isSolicited(notice: ReachOutNotice): boolean {
  return notice.solicited ?? SOLICITED_BY_NATURE.has(notice.source);
}

export function isAlwaysDeliver(notice: ReachOutNotice): boolean {
  return notice.source === "approval" || notice.priority === "critical";
}

/**
 * The dial that applies to a source right now.
 *
 * "Proactive mode" (src/autonomy/state.ts) and the dial are two switches with
 * two meanings: Proactive mode is whether Lisa may ACT unattended; the dial is
 * how much she may INTERRUPT. They are kept separate so that turning Proactive
 * mode off does not silently stop mail or brief pushes a user already gets.
 * The one place they meet: with Proactive mode off, the sources that only
 * unattended runs produce (`idle`, `desire`) are treated as dial "off".
 */
export function effectiveDial(
  settings: ReachOutSettings,
  source: ReachOutSource,
  proactiveMode: boolean,
): ReachOutDial {
  if (!proactiveMode && AUTONOMY_BORN.has(source)) return "off";
  return settings.dial;
}

/** Value-gate score for an unsolicited notice. Reuses the advisor formula. */
export function valueScore(notice: ReachOutNotice, dismissals: number): number {
  return relevanceScore({
    urgency: URGENCY_FOR[notice.priority],
    actionable: notice.actionable === true,
    dismissals,
  });
}

export interface GateContext {
  settings: ReachOutSettings;
  now: Date;
  /** Budget units already spent on today's local day. */
  budgetUsed: number;
  /** A notice with the same dedupe key was let through inside the window. */
  duplicate: boolean;
  /**
   * What an earlier notice with the same `budgetKey` settled today: "paid" ⇒
   * this one rides on that unit; "denied" ⇒ it is over budget too.
   */
  budgetShare?: "paid" | "denied" | null;
  /** Net dismissals of this source+kind inside the feedback window. */
  dismissals: number;
  /** The "Proactive mode" master switch. */
  proactiveMode: boolean;
  /** Channels that can physically deliver here (cloud has no push). */
  available: Record<ReachOutChannel, boolean>;
}

/** The charter's rule. Pure: same notice + same context ⇒ same decision. */
export function decideReachOut(notice: ReachOutNotice, ctx: GateContext): ReachOutDecision {
  const drop = (reason: ReachOutDecision["reason"]): ReachOutDecision => ({
    deliver: false,
    channels: [],
    reason,
  });

  // 1. Red lines.
  const redLine = redLineFor(notice);
  if (redLine) return drop(redLine);
  if (!notice.title.trim() && !notice.body.trim()) return drop("empty");

  // 2. Dedupe.
  if (ctx.duplicate) return drop("duplicate");

  const { settings, available } = ctx;
  const quiet = inQuietHours(ctx.now, settings.quietHours);
  const interrupting: ReachOutChannel[] = (["push", "im"] as const).filter(
    (c) => settings.channels[c] && available[c],
  );

  // 3. Approvals and critical notices always get through. In-app is forced on
  //    (an approval nobody can see blocks the user's own work); the user's
  //    choice of interrupting channels is still honoured.
  if (isAlwaysDeliver(notice)) {
    const channels: ReachOutChannel[] = [
      ...(available.inapp ? (["inapp"] as const) : []),
      ...interrupting,
    ];
    if (channels.length === 0) return drop("no-channel");
    return {
      deliver: true,
      channels,
      reason: "always-deliver",
      ...(quiet && interrupting.length > 0 ? { silent: true } : {}),
    };
  }

  // 4. Per-source switch.
  if (!settings.sources[notice.source]) return drop("source-off");

  const inapp: ReachOutChannel[] = settings.channels.inapp && available.inapp ? ["inapp"] : [];
  const inAppOnly = (reason: ReachOutDecision["reason"], extra: Partial<ReachOutDecision> = {}) =>
    inapp.length > 0
      ? { deliver: true, channels: inapp, reason, ...extra }
      : { ...drop("no-channel"), ...extra };
  const deferPush = (extra: Partial<ReachOutDecision>): ReachOutDecision => ({
    deliver: inapp.length > 0,
    channels: inapp,
    reason: "quiet-hours",
    deferred: interrupting,
    deferUntil: quietHoursEnd(ctx.now, settings.quietHours).toISOString(),
    ...extra,
  });

  // Nothing can interrupt here (cloud, or the user turned the channels off):
  // in-app is all there is, and no budget is spent on it.
  if (interrupting.length === 0) return inAppOnly("ok");

  // 5. Dial.
  const dial = effectiveDial(settings, notice.source, ctx.proactiveMode);
  if (dial === "off") return inAppOnly("dial-off");

  // 6. Solicited results.
  if (isSolicited(notice)) {
    if (quiet) return deferPush({});
    return { deliver: true, channels: [...inapp, ...interrupting], reason: "solicited" };
  }

  // 7. Unsolicited.
  if (notice.source === "desire" && !settings.desirePush) return inAppOnly("desire-in-app-only");
  const score = valueScore(notice, ctx.dismissals);
  if (score < VALUE_BAR) return inAppOnly("below-value-bar", { score });
  // A group sharing a `budgetKey` spends one unit: the first member decides.
  const rides = ctx.budgetShare === "paid";
  if (!rides && (ctx.budgetShare === "denied" || ctx.budgetUsed >= DAILY_BUDGET[dial])) {
    return inAppOnly("over-budget", { score });
  }
  const spend: Partial<ReachOutDecision> = rides ? {} : { countsBudget: true };
  if (quiet) return deferPush({ score, ...spend });
  return {
    deliver: true,
    channels: [...inapp, ...interrupting],
    reason: "ok",
    score,
    ...spend,
  };
}

export interface ReachOutDeps {
  /**
   * Where each channel goes. A channel with no transport is treated as
   * unavailable, so the decision never claims a delivery that cannot happen.
   */
  transports?: Partial<ReachOutTransports>;
  /** Channels physically usable in this context. Default: every one with a transport. */
  available?: Partial<Record<ReachOutChannel, boolean>>;
  /** Settings/ledger root. Default: the notice's tenant home (never another tenant's). */
  home?: string;
  now?: () => Date;
  /** The "Proactive mode" switch. Default: the tenant's autonomy state. */
  proactiveMode?: () => boolean;
  /** Where quiet-hours pushes wait. Default: the process-wide queue. */
  deferQueue?: DeferQueue;
  log?: (message: string) => void;
}

const SAFE_UID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

/**
 * The home a notice's settings and ledger live in, or null when the notice may
 * not be handled here: inside one tenant's request scope, a notice for a
 * different uid is refused rather than written into either tenant.
 */
export function homeForNotice(notice: ReachOutNotice): string | null {
  const scoped = scopedUid();
  if (scoped !== null && scoped !== notice.uid) return null;
  if (notice.uid === null) return lisaHome();
  if (!SAFE_UID.test(notice.uid) || notice.uid.includes("..")) return null;
  return homeForUid(notice.uid);
}

async function runTransport(
  channel: ReachOutChannel,
  transports: Partial<ReachOutTransports>,
  notice: StampedNotice,
  silent: boolean,
  log: (m: string) => void,
): Promise<boolean> {
  try {
    if (channel === "inapp") await transports.inapp?.(notice);
    else if (channel === "push") await transports.push?.(notice, { silent });
    else await transports.im?.(notice);
    return true;
  } catch (err) {
    log(`[reachout] ${channel} delivery failed for ${notice.id}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Ask to reach the user. Decides, records the decision in the ledger, delivers
 * on the allowed channels and queues what quiet hours hold back. Returns the
 * decision plus the ledger id (for feedback). Never throws.
 */
export async function reachOut(
  notice: ReachOutNotice,
  deps: ReachOutDeps = {},
): Promise<ReachOutResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const id = newLedgerId();
  const transports = deps.transports ?? {};
  const available: Record<ReachOutChannel, boolean> = {
    inapp: typeof transports.inapp === "function" && deps.available?.inapp !== false,
    push: typeof transports.push === "function" && deps.available?.push !== false,
    im: typeof transports.im === "function" && deps.available?.im !== false,
  };

  const home = deps.home ?? homeForNotice(notice);
  if (!home) {
    log(
      `[reachout] refused ${notice.source}/${notice.kind}: notice uid does not match the active tenant`,
    );
    return { id, deliver: false, channels: [], reason: "tenant-mismatch" };
  }

  let decision: ReachOutDecision;
  try {
    decision = await withReachOutLock(home, async () => {
      const current = loadReachOutSettings(home);
      const entries = readLedger(home);
      const proactiveMode = deps.proactiveMode
        ? deps.proactiveMode()
        : homeScope.run(home, () => getAutonomyEnabled());
      const day = localMoment(now, current.quietHours.tz).day;
      const d = decideReachOut(notice, {
        settings: current,
        now,
        budgetUsed: budgetUsed(entries, day),
        budgetShare: budgetShare(entries, notice.budgetKey, day),
        duplicate: seenRecently(entries, notice.dedupeKey, now),
        dismissals: netDismissals(entries, notice.source, notice.kind, now),
        proactiveMode,
        available,
      });
      await appendLedger(
        [noticeEntry(id, notice, d, now, current.quietHours.tz, isSolicited(notice))],
        home,
        now,
      );
      return d;
    });
  } catch (err) {
    // The gate could not read its state or write its ledger. Fail quiet, not
    // silent: in-app still shows it, and only the always-deliver class may
    // interrupt. Red lines hold regardless.
    log(`[reachout] gate error for ${notice.source}/${notice.kind}: ${(err as Error).message}`);
    const redLine = redLineFor(notice);
    const channels: ReachOutChannel[] = redLine
      ? []
      : (["inapp", "push", "im"] as const).filter(
          (c) => available[c] && (c === "inapp" || (isAlwaysDeliver(notice) && c === "push")),
        );
    decision = { deliver: channels.length > 0, channels, reason: redLine ?? "gate-error" };
  }

  if (decision.reason.startsWith("red-line")) {
    // Logged without content: what was refused, never what it said.
    log(`[reachout] ${decision.reason} — denied ${notice.source}/${notice.kind} (${id})`);
  }

  const stamped: StampedNotice = { ...notice, id, from: "Lisa", ai: true, at: now.toISOString() };
  for (const channel of decision.channels) {
    await runTransport(channel, transports, stamped, decision.silent === true, log);
  }

  if (decision.deferred?.length && decision.deferUntil) {
    const held = decision.deferred;
    (deps.deferQueue ?? sharedDeferQueue()).enqueue({
      id,
      dueAt: Date.parse(decision.deferUntil),
      channels: held,
      release: async (at) => {
        // Re-read the user's settings: they may have changed their mind (or
        // their quiet hours) while this was waiting.
        const latest = loadReachOutSettings(home);
        if (inQuietHours(at, latest.quietHours)) {
          return { retryAt: quietHoursEnd(at, latest.quietHours).getTime() };
        }
        const stillWanted =
          latest.sources[notice.source] &&
          latest.dial !== "off" &&
          (notice.source !== "desire" || latest.desirePush);
        const released: ReachOutChannel[] = [];
        if (stillWanted) {
          for (const channel of held) {
            if (!latest.channels[channel]) continue;
            if (await runTransport(channel, transports, stamped, false, log))
              released.push(channel);
          }
        }
        try {
          await withReachOutLock(home, () =>
            appendLedger(
              [{ v: 1, type: "release", id, ts: at.toISOString(), channels: released }],
              home,
              at,
            ),
          );
        } catch (err) {
          log(`[reachout] could not record release of ${id}: ${(err as Error).message}`);
        }
        return { released };
      },
    });
  }

  return { ...decision, id };
}
