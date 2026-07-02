import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

export interface TranscribeOptions {
  audioPath: string;
  /** OpenAI Whisper model override (ignored by the ElevenLabs path). */
  model?: string;
  /** OpenAI key override (back-compat); ElevenLabs uses ELEVENLABS_API_KEY. */
  apiKey?: string;
}

/**
 * Transcribe a recorded audio file to text.
 *
 * Provider order: ElevenLabs Scribe (ELEVENLABS_API_KEY) → OpenAI Whisper
 * (OPENAI_API_KEY / opts.apiKey). The signature is unchanged so callers don't
 * care which provider runs.
 */
export async function transcribeAudio(opts: TranscribeOptions): Promise<string> {
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (elevenKey) {
    return transcribeWithElevenLabs(opts.audioPath, elevenKey);
  }
  const openaiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return transcribeWithOpenAI(opts.audioPath, openaiKey, opts.model);
  }
  throw new Error(
    "Voice transcription needs ELEVENLABS_API_KEY (ElevenLabs Scribe) or OPENAI_API_KEY (OpenAI Whisper).",
  );
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
async function transcribeWithElevenLabs(audioPath: string, apiKey: string): Promise<string> {
  const buf = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf]), path.basename(audioPath) || "audio.webm");
  form.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v1");

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
