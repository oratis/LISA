/**
 * Sense — ambient signal sources (PLAN_SENSE S2). These are NOT agent sessions,
 * so they get their own abstraction parallel to AgentObserver rather than being
 * shoved into the orchestrator hub.
 *
 * Every source is consent-gated (FOUNDATIONS §1): it captures nothing unless the
 * user has granted its signal, and it surfaces only STRUCTURED metadata — never
 * raw screen bytes, raw audio, or unredacted content.
 */

/** A distilled, structured observation from an ambient source. Never raw bytes. */
export interface SenseEvent {
  /** The consent signal this came from, e.g. "screen" / "voice". */
  signal: string;
  /** Source-specific event kind, e.g. "foreground-app". */
  kind: string;
  /** Foreground app name (structural, low-sensitivity). */
  app?: string;
  /** Window title — only when safe (blacklist-checked + PII-redacted). */
  title?: string;
  /** Short structured summary for display / distillation. */
  summary: string;
  /** Epoch ms. */
  ts: number;
}

/**
 * An ambient source. Stateful (holds a timer between start/stop). It must check
 * consent itself on every capture — start() does not imply permission, and a
 * mid-run revoke must take effect within one cycle.
 */
export interface SenseSource {
  readonly signal: string;
  start(emit: (e: SenseEvent) => void): Promise<void>;
  stop(): Promise<void>;
}
