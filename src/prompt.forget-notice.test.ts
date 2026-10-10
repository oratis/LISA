import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway home before the path helpers are imported (see mood-bus.test.ts).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-prompt-forget-"));
process.env.LISA_HOME = TMP;
process.env.LISA_SOUL_GIT = "0";

const { buildSystemPromptSnapshot, getPromptFingerprint } = await import("./prompt.js");
const soulStore = await import("./soul/store.js");

describe("system prompt — Lisa is told when the person used Forget", () => {
  test("a recent forget adds a topic-free Notice and moves the fingerprint", async () => {
    await soulStore.writeSeed({
      bornAt: new Date().toISOString(),
      bigFive: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
      },
    } as never);
    await soulStore.writeName("Lisa");
    const before = await getPromptFingerprint();
    const without = await buildSystemPromptSnapshot();
    assert.doesNotMatch(without.text, /used Forget/);

    fs.mkdirSync(path.join(TMP, "sovereignty"), { recursive: true });
    fs.writeFileSync(
      path.join(TMP, "sovereignty", "forget-notice.json"),
      JSON.stringify({ at: new Date().toISOString(), journal: 2, relationships: 1, memory: 3 }),
    );
    assert.notEqual(await getPromptFingerprint(), before);
    const { text } = await buildSystemPromptSnapshot();
    assert.match(text, /used Forget/);
    assert.match(text, /2 passage\(s\) in your journal and 1 in your relationship notes/);
    assert.match(text, /user-forget/);
  });

  test("an old notice (over a week) is no longer shown", async () => {
    fs.writeFileSync(
      path.join(TMP, "sovereignty", "forget-notice.json"),
      JSON.stringify({
        at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        journal: 1,
        relationships: 0,
        memory: 0,
      }),
    );
    const { text } = await buildSystemPromptSnapshot();
    assert.doesNotMatch(text, /used Forget/);
  });
});
