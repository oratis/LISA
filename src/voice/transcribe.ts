import fs from "node:fs";
import OpenAI from "openai";

export interface TranscribeOptions {
  audioPath: string;
  model?: string;
  apiKey?: string;
}

export async function transcribeAudio(opts: TranscribeOptions): Promise<string> {
  if (!process.env.OPENAI_API_KEY && !opts.apiKey) {
    throw new Error(
      "Voice transcription needs OPENAI_API_KEY (uses OpenAI Whisper).",
    );
  }
  const client = new OpenAI({ apiKey: opts.apiKey });
  const result = await client.audio.transcriptions.create({
    model: opts.model ?? "whisper-1",
    file: fs.createReadStream(opts.audioPath),
  });
  return result.text;
}
