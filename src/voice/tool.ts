import path from "node:path";
import fs from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { transcribeAudio } from "./transcribe.js";
import { speak } from "./speak.js";

interface SpeakInput {
  text: string;
  voice?: string;
  rate?: number;
}

export const speakTool: ToolDefinition<SpeakInput, string> = {
  name: "speak",
  description:
    "Read text aloud through the macOS speech synthesizer (`/usr/bin/say`). " +
    "Use sparingly — only when the user is in a voice / hands-free context.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      voice: { type: "string" },
      rate: { type: "integer", minimum: 80, maximum: 400 },
    },
    required: ["text"],
  },
  async execute(input) {
    await speak(input);
    return `spoke ${input.text.length} chars`;
  },
};

interface TranscribeInput {
  audio_path: string;
  model?: string;
}

export const transcribeTool: ToolDefinition<TranscribeInput, string> = {
  name: "transcribe",
  description:
    "Transcribe an audio file (m4a/mp3/wav/etc.) using OpenAI Whisper. " +
    "Requires OPENAI_API_KEY. Returns the transcript text.",
  inputSchema: {
    type: "object",
    properties: {
      audio_path: { type: "string" },
      model: { type: "string", default: "whisper-1" },
    },
    required: ["audio_path"],
  },
  async execute(input, ctx) {
    const abs = path.resolve(ctx.cwd, input.audio_path);
    await fs.access(abs);
    return await transcribeAudio({ audioPath: abs, model: input.model });
  },
};
