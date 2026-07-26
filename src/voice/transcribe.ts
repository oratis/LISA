import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { parseFile } from "music-metadata";
import type { MediaProvider, MediaUsage } from "../billing/media-prices.js";

export interface TranscribeOptions {
  audioPath: string;
  /** OpenAI Whisper model override (ignored by the ElevenLabs path). */
  model?: string;
  /** OpenAI key override (back-compat); ElevenLabs uses ELEVENLABS_API_KEY. */
  apiKey?: string;
}

export interface PreparedTranscription {
  audioPath: string;
  provider: MediaProvider;
  model: string;
  durationMs: number;
}

export interface MeteredTranscription {
  text: string;
  usage: MediaUsage;
}

export const DEFAULT_MAX_TRANSCRIPTION_SECONDS = 10 * 60;

export class AudioValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioValidationError";
  }
}

function configuredPlan(opts: TranscribeOptions): {
  provider: MediaProvider;
  model: string;
  apiKey: string;
} {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (elevenKey) {
    return {
      provider: "elevenlabs",
      model: process.env.ELEVENLABS_STT_MODEL || "scribe_v2",
      apiKey: elevenKey,
    };
  }
  const openaiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return { provider: "openai", model: opts.model ?? "whisper-1", apiKey: openaiKey };
  }
  throw new Error(
    "Voice transcription needs ELEVENLABS_API_KEY (ElevenLabs Scribe) or OPENAI_API_KEY (OpenAI Whisper).",
  );
}

export function maxTranscriptionSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env.LISA_VOICE_MAX_SECONDS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_MAX_TRANSCRIPTION_SECONDS;
}

/**
 * Parse duration on the server before any provider call. This is the billing
 * source of truth; client-supplied duration is intentionally ignored.
 */
export async function prepareTranscription(
  opts: TranscribeOptions,
  maxSeconds: number = maxTranscriptionSeconds(),
): Promise<PreparedTranscription> {
  const plan = configuredPlan(opts);
  let durationSeconds: number | undefined;
  try {
    const metadata = await parseFile(opts.audioPath, { duration: true });
    durationSeconds = metadata.format.duration;
  } catch (err) {
    throw new AudioValidationError(
      `cannot read audio duration: ${(err as Error).message}`,
      400,
      { cause: err },
    );
  }
  if (!Number.isFinite(durationSeconds) || (durationSeconds ?? 0) <= 0) {
    throw new AudioValidationError("audio has no measurable duration", 400);
  }
  if (durationSeconds! > maxSeconds) {
    throw new AudioValidationError(
      `audio exceeds the ${maxSeconds}-second transcription limit`,
      413,
    );
  }
  return {
    audioPath: opts.audioPath,
    provider: plan.provider,
    model: plan.model,
    durationMs: Math.ceil(durationSeconds! * 1000),
  };
}

export async function transcribePrepared(prepared: PreparedTranscription): Promise<string> {
  const plan = configuredPlan({
    audioPath: prepared.audioPath,
    model: prepared.provider === "openai" ? prepared.model : undefined,
  });
  if (plan.provider !== prepared.provider || plan.model !== prepared.model) {
    throw new Error("transcription provider configuration changed during the request");
  }
  return plan.provider === "elevenlabs"
    ? transcribeWithElevenLabs(prepared.audioPath, plan.apiKey, plan.model)
    : transcribeWithOpenAI(prepared.audioPath, plan.apiKey, plan.model);
}

export async function transcribeAudioMetered(
  opts: TranscribeOptions,
  maxSeconds: number = maxTranscriptionSeconds(),
): Promise<MeteredTranscription> {
  const prepared = await prepareTranscription(opts, maxSeconds);
  const text = await transcribePrepared(prepared);
  return {
    text,
    usage: {
      provider: prepared.provider,
      model: prepared.model,
      durationMs: prepared.durationMs,
    },
  };
}

/**
 * Transcribe a recorded audio file to text.
 *
 * Provider order: ElevenLabs Scribe (ELEVENLABS_API_KEY) → OpenAI Whisper
 * (OPENAI_API_KEY / opts.apiKey). The signature is unchanged so callers don't
 * care which provider runs.
 */
export async function transcribeAudio(opts: TranscribeOptions): Promise<string> {
  const plan = configuredPlan(opts);
  return plan.provider === "elevenlabs"
    ? transcribeWithElevenLabs(opts.audioPath, plan.apiKey, plan.model)
    : transcribeWithOpenAI(opts.audioPath, plan.apiKey, plan.model);
}

async function transcribeWithOpenAI(
  audioPath: string,
  apiKey: string,
  model?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey });
  const result = await client.audio.transcriptions.create({
    model: model ?? "whisper-1",
    file: fs.createReadStream(audioPath),
  });
  return result.text;
}

/**
 * ElevenLabs Scribe speech-to-text — POST /v1/speech-to-text, multipart `file` +
 * `model_id`, authed with the `xi-api-key` header. Returns `{ text }`.
 */
async function transcribeWithElevenLabs(
  audioPath: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const buf = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf]), path.basename(audioPath) || "audio.webm");
  form.append("model_id", model);

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ElevenLabs transcription failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const json = (await res.json().catch(() => ({}))) as { text?: string };
  if (typeof json.text !== "string") {
    throw new Error("ElevenLabs returned no transcript text.");
  }
  return json.text;
}
