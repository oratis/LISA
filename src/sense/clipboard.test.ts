import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyClipboardKind, ClipboardSource, evaluateClipboardTick } from "./clipboard.js";
import type { SenseEvent } from "./types.js";

describe("clipboard metadata sense helpers (Sense S4)", () => {
  test("classifyClipboardKind maps UTI strings to coarse categories without reading payloads", () => {
    assert.equal(classifyClipboardKind(["public.file-url", "public.utf8-plain-text"]), "file");
    assert.equal(classifyClipboardKind(["public.url", "public.utf8-plain-text"]), "url");
    assert.equal(classifyClipboardKind(["public.png"]), "image");
    assert.equal(classifyClipboardKind(["public.utf8-plain-text"]), "text");
    assert.equal(classifyClipboardKind([]), "unknown");
  });

  test("evaluateClipboardTick captures baseline quietly and suppresses blacklisted apps while advancing count", () => {
    const baseline = evaluateClipboardTick(undefined, { changeCount: 10, app: "Cursor" }, 100);
    assert.equal(baseline.nextChangeCount, 10);
    assert.equal(baseline.event, null);

    // Copy in 1Password -> no event, but changeCount advances so switching away won't attribute it later.
    const secret = evaluateClipboardTick(
      baseline.nextChangeCount,
      { changeCount: 11, types: ["public.utf8-plain-text"], app: "1Password" },
      200,
    );
    assert.equal(secret.nextChangeCount, 11);
    assert.equal(secret.event, null);

    // Switching to Cursor without copying again -> same changeCount -> still no event.
    const afterSwitch = evaluateClipboardTick(
      secret.nextChangeCount,
      { changeCount: 11, types: ["public.utf8-plain-text"], app: "Cursor" },
      300,
    );
    assert.equal(afterSwitch.nextChangeCount, 11);
    assert.equal(afterSwitch.event, null);

    // Real copy in Cursor -> metadata-only event.
    const realCopy = evaluateClipboardTick(
      afterSwitch.nextChangeCount,
      { changeCount: 12, types: ["public.utf8-plain-text"], app: "Cursor" },
      400,
    );
    assert.equal(realCopy.nextChangeCount, 12);
    assert.deepEqual(realCopy.event, {
      signal: "clipboard",
      kind: "clipboard-change",
      app: "Cursor",
      summary: "clipboard text updated in Cursor",
      ts: 400,
    });
  });

  test("ClipboardSource is consent-gated per tick and forgets tracked count on revoke", async () => {
    let granted = false;
    let count = 5;
    const app = "Terminal";
    const events: SenseEvent[] = [];

    const src = new ClipboardSource({
      granted: () => granted,
      now: () => 1234,
      probe: async () => ({ changeCount: count, types: ["public.url"], app }),
    });
    await src.start((e) => events.push(e));
    try {
      // Ungranted -> probe not emitted
      await src.tick();
      assert.equal(events.length, 0);

      // Grant -> first tick sets baseline silently
      granted = true;
      await src.tick();
      assert.equal(events.length, 0);

      // Next change -> emits metadata
      count = 6;
      await src.tick();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.summary, "clipboard url updated in Terminal");

      // Mid-run revoke -> stops and clears baseline so re-grant starts with fresh baseline
      granted = false;
      count = 7;
      await src.tick();
      assert.equal(events.length, 1);

      granted = true;
      await src.tick();
      assert.equal(events.length, 1); // fresh baseline, does not emit copy #7!

      count = 8;
      await src.tick();
      assert.equal(events.length, 2);
    } finally {
      await src.stop();
    }
  });

  test("source scan: clipboard module never calls pasteboard content-reading APIs", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "clipboard.ts"), "utf8");
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/pbpaste|stringForType|dataForType|propertyListForType/.test(codeOnly), false);
  });
});
