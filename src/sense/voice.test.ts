import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { distillVoiceTranscript, VoiceSource } from "./voice.js";
import type { SenseEvent } from "./types.js";

const NOW = 1_700_000_000_000;

describe("distillVoiceTranscript (pure)", () => {
  test("normal speech → a voice-transcript event", () => {
    const ev = distillVoiceTranscript("remind me to push the branch", NOW)!;
    assert.equal(ev.signal, "voice");
    assert.equal(ev.kind, "voice-transcript");
    assert.equal(ev.summary, "remind me to push the branch");
    assert.equal(ev.ts, NOW);
  });

  test("empty / whitespace → null", () => {
    assert.equal(distillVoiceTranscript("", NOW), null);
    assert.equal(distillVoiceTranscript("   ", NOW), null);
  });

  test("PII is redacted in the summary", () => {
    const ev = distillVoiceTranscript("email me at a@b.com", NOW)!;
    assert.equal(ev.summary, "email me at [email]");
  });

  test("a transcript naming a secret path is dropped entirely", () => {
    assert.equal(distillVoiceTranscript("open ~/project/.env and read it", NOW), null);
  });

  test("long transcripts are length-capped", () => {
    const long = "word ".repeat(200).trim();
    const ev = distillVoiceTranscript(long, NOW)!;
    assert.ok(ev.summary.length <= 281, `summary should be capped, got ${ev.summary.length}`);
    assert.ok(ev.summary.endsWith("…"));
  });

  test("never carries audio — only signal/kind/summary/ts keys", () => {
    const ev = distillVoiceTranscript("hi", NOW)!;
    assert.deepEqual(Object.keys(ev).sort(), ["kind", "signal", "summary", "ts"].sort());
  });
});

describe("VoiceSource (consent-gated ingest)", () => {
  test("ingest is a no-op until voice is granted", async () => {
    const emitted: SenseEvent[] = [];
    const src = new VoiceSource({ granted: () => false, now: () => NOW });
    await src.start((e) => emitted.push(e));
    const r = src.ingest("hello there");
    await src.stop();
    assert.equal(r, null);
    assert.equal(emitted.length, 0);
  });

  test("ingest distills + emits when granted", async () => {
    const emitted: SenseEvent[] = [];
    const src = new VoiceSource({ granted: () => true, now: () => NOW });
    await src.start((e) => emitted.push(e));
    const r = src.ingest("ship the PR");
    await src.stop();
    assert.equal(r!.summary, "ship the PR");
    assert.deepEqual(emitted.map((e) => e.summary), ["ship the PR"]);
  });

  test("granted but empty transcript → nothing emitted", async () => {
    const emitted: SenseEvent[] = [];
    const src = new VoiceSource({ granted: () => true, now: () => NOW });
    await src.start((e) => emitted.push(e));
    assert.equal(src.ingest("  "), null);
    await src.stop();
    assert.equal(emitted.length, 0);
  });
});
