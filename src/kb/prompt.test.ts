import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-kb-prompt-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const prompt = await import("../prompt.js");
const kb = await import("./store.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

describe("kb ⇄ prompt integration", () => {
  test("empty KB → no knowledge-base section in the prompt", async () => {
    const snap = await prompt.buildSystemPromptSnapshot();
    assert.doesNotMatch(snap.text, /Personal knowledge base/);
  });

  test("capturing a source injects the KB section (schema + index)", async () => {
    await kb.addSource({
      title: "OAuth PKCE",
      body: "code_verifier / code_challenge",
      tags: ["oauth"],
    });
    const snap = await prompt.buildSystemPromptSnapshot();
    assert.match(snap.text, /## Personal knowledge base/);
    assert.match(snap.text, /### Schema/);
    assert.match(snap.text, /### Index/);
    assert.match(snap.text, /OAuth PKCE/, "the captured title shows up in the index");
  });

  test("getPromptFingerprint shifts when the KB changes (mid-session hot-reload)", async () => {
    const before = await prompt.getPromptFingerprint();
    await kb.writeWiki({ title: "OAuth", body: "authorization framework", tags: ["oauth"] });
    const after = await prompt.getPromptFingerprint();
    assert.notEqual(before, after, "a KB write must change the prompt fingerprint");
  });
});
