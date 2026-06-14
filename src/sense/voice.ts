/**
 * Voice sense source (PLAN_SENSE S2-voice) — push-to-talk transcripts as an
 * ambient signal, built on F-consent.
 *
 * It rides the EXISTING transcribe pipeline (browser MediaRecorder → Whisper)
 * rather than opening the mic itself: the user already speaks intentionally
 * (push-to-talk, the plan's default over always-on). What S2-voice adds is, when
 * `voice` is granted, distilling those transcripts into the ambient sense log as
 * context. Default off → dictation works exactly as before and nothing is logged.
 *
 * Privacy: raw AUDIO is never stored (there is none here — only the transcript
 * the user chose to speak); the persisted summary is PII-redacted and dropped
 * entirely if it names a secret path. Always-on listening and a local STT
 * (whisper.cpp) for off-device transcription are deliberate follow-ups.
 */
import { isGranted } from "../consent/store.js";
import { redactPII, isBlacklistedPath } from "../consent/blacklist.js";
import type { SenseEvent, SenseSource } from "./types.js";

const MAX_SUMMARY = 280;

/**
 * Distill a transcript into a structured SenseEvent. Pure. PII-redacted and
 * length-capped; null for empty text or text that names a secret path. Never
 * touches audio bytes.
 */
export function distillVoiceTranscript(transcript: string, now: number): SenseEvent | null {
  const text = (transcript || "").trim();
  if (!text) return null;
  if (isBlacklistedPath(text)) return null; // mentions a secret path → don't log
  const redacted = redactPII(text);
  const summary = redacted.length > MAX_SUMMARY ? redacted.slice(0, MAX_SUMMARY) + "…" : redacted;
  return { signal: "voice", kind: "voice-transcript", summary, ts: now };
}

export interface VoiceSourceOptions {
  now?: () => number;
  /** Injectable consent check (tests); defaults to the real consent store. */
  granted?: () => boolean;
}

export class VoiceSource implements SenseSource {
  readonly signal = "voice";
  private emitFn: ((e: SenseEvent) => void) | null = null;
  private readonly now: () => number;
  private readonly granted: () => boolean;

  constructor(opts: VoiceSourceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.granted = opts.granted ?? (() => isGranted("voice"));
  }

  // Event-driven (not polled): start just wires the sink, stop unwires it.
  async start(emit: (e: SenseEvent) => void): Promise<void> {
    this.emitFn = emit;
  }
  async stop(): Promise<void> {
    this.emitFn = null;
  }

  /**
   * Feed a push-to-talk transcript. Distills + emits IFF `voice` is granted;
   * a no-op (returns null) otherwise — ambient capture always requires consent.
   * Returns the event (for tests / callers) or null.
   */
  ingest(transcript: string): SenseEvent | null {
    if (!this.granted()) return null;
    const ev = distillVoiceTranscript(transcript, this.now());
    if (ev && this.emitFn) this.emitFn(ev);
    return ev;
  }
}
