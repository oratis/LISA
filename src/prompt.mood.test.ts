import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway home before the path helpers are imported (see mood-bus.test.ts).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-prompt-mood-"));
process.env.LISA_HOME = TMP;

const { moodBus, withMoodOrigin } = await import("./mood-bus.js");
const { buildSystemPromptSnapshot, getPromptFingerprint } = await import("./prompt.js");

/**
 * The avatar was write-only: set_mood wrote to the bus, the GUI drew the
 * portrait, and nothing carried the slug back — so asked "why are you happy?"
 * Lisa could only inspect her emotion vector and guess. These are the
 * acceptance tests for the read side.
 */
describe("system prompt — Lisa can see the portrait the user is looking at", () => {
  test("says so plainly when nobody has set one", async () => {
    const { text } = await buildSystemPromptSnapshot();
    assert.match(text, /## Avatar moods/);
    assert.match(text, /nobody has set it yet/);
  });

  test("names the current slug, its age, and which kind of turn set it", async () => {
    withMoodOrigin("an idle turn while the user was away", () => moodBus.set("happy"));
    const { text } = await buildSystemPromptSnapshot();
    assert.match(text, /Right now they see `happy` — set moments ago by an idle turn while the user was away\./);
  });

  test("warns that the portrait and the emotion vector are different systems", async () => {
    const { text } = await buildSystemPromptSnapshot();
    // The failure this prevents: answering "I'm not happy, look at my
    // emotions" while a happy portrait is on screen.
    assert.match(text, /not the same thing as your emotional state/);
    assert.match(text, /shared by every turn you take/);
  });

  test("a mood set by another surface hot-reloads into the next turn", async () => {
    const before = await getPromptFingerprint();
    moodBus.set("working-coding");
    const after = await getPromptFingerprint();
    assert.notEqual(
      before,
      after,
      "fingerprint must move when the avatar changes, or the running chat keeps asserting a stale portrait",
    );
    const { text } = await buildSystemPromptSnapshot();
    assert.match(text, /Right now they see `working-coding`/);
  });

  test("re-setting the same slug leaves the fingerprint alone (no prompt-cache churn)", async () => {
    const before = await getPromptFingerprint();
    moodBus.set("working-coding");
    assert.equal(await getPromptFingerprint(), before);
  });
});
