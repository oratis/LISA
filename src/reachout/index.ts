/**
 * Reach-out — public surface. Other modules import from here.
 *
 *   import { reachOut, type ReachOutNotice } from "../reachout/index.js";
 *
 * See docs/POLICY_REACH_OUT.md for the rules and gate.ts for their order.
 */
export * from "./types.js";
export {
  reachOut,
  decideReachOut,
  effectiveDial,
  homeForNotice,
  isAlwaysDeliver,
  isSolicited,
  valueScore,
  VALUE_BAR,
  type GateContext,
  type ReachOutDeps,
} from "./gate.js";
export {
  DAILY_BUDGET,
  REACH_OUT_SETTINGS_VERSION,
  applyReachOutPatch,
  defaultReachOutSettings,
  loadReachOutSettings,
  normalizeReachOutSettings,
  reachOutDir,
  reachOutSettingsPath,
  saveReachOutSettings,
  type QuietHours,
  type ReachOutChannelPrefs,
  type ReachOutCompliance,
  type ReachOutSettings,
} from "./settings.js";
export {
  DEDUPE_WINDOW_MS,
  FEEDBACK_WINDOW_MS,
  aggregateLedger,
  readLedger,
  reachOutLedgerPath,
  recordReachOutFeedback,
  type LedgerAggregate,
  type LedgerEntry,
  type SourceTally,
} from "./ledger.js";
export {
  PUSH_PREF_FOR,
  attributedTitle,
  createReachOutTransports,
  hasReachOutImHook,
  setReachOutImHook,
  type ImHook,
  type InAppSink,
  type PushSink,
} from "./deliver.js";
export { DeferQueue, sharedDeferQueue } from "./defer.js";
export { inQuietHours, localMoment, quietHoursEnd } from "./clock.js";
export { looksLikeDataConnectionAsk, looksLikeEmotionalPressure, redLineFor } from "./redlines.js";
export {
  advisorNotice,
  idleNoteNotice,
  kbBriefNotice,
  mailAlertNotice,
  mailDigestNotice,
} from "./senders.js";
