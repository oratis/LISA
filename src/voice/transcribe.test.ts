import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcribeAudio } from "./transcribe.js";

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

  globalThis.fetch = (async (url: unknown, init: { headers?: Record<string, string>; body?: unknown }) => {
    calledUrl = String(url);
    sentKey = init?.headers?.["xi-api-key"];
    sentFile = init?.body instanceof FormData && (init.body as FormData).has("file");
    return new Response(JSON.stringify({ text: "hello world" }), { status: 200 });
  }) as typeof fetch;

  try {
    await withEnv("ELEVENLABS_API_KEY", "sk_test_key", async () => {
      const text = await transcribeAudio({ audioPath: tmp });
      assert.equal(text, "hello world");
      assert.match(calledUrl, /api\.elevenlabs\.io\/v1\/speech-to-text$/);
      assert.equal(sentKey, "sk_test_key");
      assert.ok(sentFile, "posts a `file` field in multipart FormData");
    });
  } finally {
    globalThis.fetch = realFetch;
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
