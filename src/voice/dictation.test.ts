import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cleanDictationOutput, polishDictation, type DictationProvider } from "./dictation.js";

describe("cleanDictationOutput", () => {
  test("passes clean text through", () => {
    assert.equal(cleanDictationOutput("Send it to Alice.", "fb"), "Send it to Alice.");
  });
  test("strips code fences", () => {
    assert.equal(cleanDictationOutput("```\nHello there.\n```", "fb"), "Hello there.");
  });
  test("unwraps a single pair of surrounding quotes", () => {
    assert.equal(cleanDictationOutput('"Hello there."', "fb"), "Hello there.");
    assert.equal(cleanDictationOutput("“Hello.”", "fb"), "Hello.");
  });
  test("does NOT unwrap when quotes are internal only", () => {
    assert.equal(cleanDictationOutput('She said "hi" to me.', "fb"), 'She said "hi" to me.');
  });
  test("strips a leading 'Here is...' preamble", () => {
    assert.equal(cleanDictationOutput("Here's the cleaned text: Ship it.", "fb"), "Ship it.");
  });
  test("falls back to the transcript when output is empty", () => {
    assert.equal(cleanDictationOutput("", "raw transcript"), "raw transcript");
    assert.equal(cleanDictationOutput(null, "raw transcript"), "raw transcript");
  });
});

describe("polishDictation", () => {
  function fakeProvider(reply: string, capture?: (sys: string, content: unknown) => void): DictationProvider {
    return {
      async runTurn(opts) {
        capture?.(opts.systemPrompt, opts.messages[0]!.content);
        return { content: [{ type: "text", text: reply }] };
      },
    };
  }

  test("empty transcript → empty (no LLM call needed)", async () => {
    let called = false;
    const provider: DictationProvider = {
      async runTurn() {
        called = true;
        return { content: [] };
      },
    };
    assert.equal(await polishDictation({ provider, model: "m", transcript: "   " }), "");
    assert.equal(called, false);
  });

  test("sends the raw transcript with the dictation system prompt; returns cleaned text", async () => {
    let seenSys = "";
    let seenContent: unknown = null;
    const provider = fakeProvider("Send it to Alice.", (sys, content) => {
      seenSys = sys;
      seenContent = content;
    });
    const out = await polishDictation({
      provider,
      model: "m",
      transcript: "um, send it to Bob, no wait, to Alice",
    });
    assert.equal(out, "Send it to Alice.");
    assert.match(seenSys, /dictation cleanup engine/i);
    assert.equal(seenContent, "um, send it to Bob, no wait, to Alice");
  });

  test("cleans the model's quoted output", async () => {
    const out = await polishDictation({
      provider: fakeProvider('"Ship the release."'),
      model: "m",
      transcript: "ship the release",
    });
    assert.equal(out, "Ship the release.");
  });
});
