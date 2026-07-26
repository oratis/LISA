import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-media-meter-"));
process.env.LISA_HOME = TMP;

const { readMediaUsage, recordMediaUsage, summarizeMediaUsage } =
  await import("./media-meter.js");

test("media ledger records and summarizes duration-priced usage", async () => {
  const now = new Date("2026-07-26T12:00:00.000Z");
  const record = await recordMediaUsage(
    "voice_transcription",
    {
      provider: "elevenlabs",
      model: "scribe_v2",
      durationMs: 1000,
    },
    now,
  );
  assert.equal(record.microUSD, 86);
  assert.deepEqual(await readMediaUsage(), [record]);
  assert.deepEqual(await summarizeMediaUsage(now.getTime() - 1), {
    microUSD: 86,
    durationMs: 1000,
    operations: 1,
  });
});
