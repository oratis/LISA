import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AudioValidationError,
  prepareTranscription,
  transcribeAudio,
} from "./transcribe.js";

function oneSecondWav(): Buffer {
  const sampleRate = 8_000;
  const dataSize = sampleRate * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  return out;
}

async function withEnv(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("no key configured → error names BOTH providers", async () => {
  await withEnv("ELEVENLABS_API_KEY", undefined, () =>
    withEnv("OPENAI_API_KEY", undefined, async () => {
      await assert.rejects(
        () => transcribeAudio({ audioPath: "/no/such/file.webm" }),
        /ELEVENLABS_API_KEY[\s\S]*OPENAI_API_KEY/,
      );
    }),
  );
});

test("ElevenLabs is preferred and POSTs the file with xi-api-key", async () => {
  const tmp = path.join(os.tmpdir(), `lisa-asr-${process.pid}.webm`);
  fs.writeFileSync(tmp, Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // a few bytes
  const realFetch = globalThis.fetch;
  let calledUrl = "";
  let sentKey: unknown;
  let sentFile = false;
  let sentModel: unknown;

  globalThis.fetch = (async (url: unknown, init: { headers?: Record<string, string>; body?: unknown }) => {
    calledUrl = String(url);
    sentKey = init?.headers?.["xi-api-key"];
    sentFile = init?.body instanceof FormData && (init.body as FormData).has("file");
    sentModel = init?.body instanceof FormData
      ? (init.body as FormData).get("model_id")
      : undefined;
    return new Response(JSON.stringify({ text: "hello world" }), { status: 200 });
  }) as typeof fetch;

  try {
    await withEnv("ELEVENLABS_API_KEY", "sk_test_key", async () => {
      const text = await transcribeAudio({ audioPath: tmp });
      assert.equal(text, "hello world");
      assert.match(calledUrl, /api\.elevenlabs\.io\/v1\/speech-to-text$/);
      assert.equal(sentKey, "sk_test_key");
      assert.ok(sentFile, "posts a `file` field in multipart FormData");
      assert.equal(sentModel, "scribe_v2");
    });
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { force: true });
  }
});

test("server-side metadata determines duration and enforces the clip limit", async () => {
  const tmp = path.join(os.tmpdir(), `lisa-asr-duration-${process.pid}.wav`);
  fs.writeFileSync(tmp, oneSecondWav());
  try {
    await withEnv("ELEVENLABS_API_KEY", "sk_test_key", async () => {
      const prepared = await prepareTranscription({ audioPath: tmp }, 2);
      assert.equal(prepared.provider, "elevenlabs");
      assert.equal(prepared.model, "scribe_v2");
      assert.ok(prepared.durationMs >= 999 && prepared.durationMs <= 1001);
      await assert.rejects(
        () => prepareTranscription({ audioPath: tmp }, 0.5),
        (err: unknown) =>
          err instanceof AudioValidationError &&
          err.status === 413 &&
          /0.5-second/.test(err.message),
      );
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("ElevenLabs non-2xx surfaces a useful error", async () => {
  const tmp = path.join(os.tmpdir(), `lisa-asr-err-${process.pid}.webm`);
  fs.writeFileSync(tmp, Buffer.from([1, 2, 3]));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("invalid_api_key", { status: 401 })) as typeof fetch;
  try {
    await withEnv("ELEVENLABS_API_KEY", "sk_bad", async () => {
      await assert.rejects(
        () => transcribeAudio({ audioPath: tmp }),
        /ElevenLabs transcription failed \(401\)/,
      );
    });
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { force: true });
  }
});
