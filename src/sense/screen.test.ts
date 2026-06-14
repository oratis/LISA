import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shouldEmitForeground, ScreenSource, type ForegroundProbe } from "./screen.js";
import type { SenseEvent } from "./types.js";

const NOW = 1_700_000_000_000;

describe("shouldEmitForeground (pure, privacy-critical)", () => {
  test("new foreground app → event with app name + summary", () => {
    const ev = shouldEmitForeground(undefined, { app: "Visual Studio Code" }, NOW);
    assert.ok(ev);
    assert.equal(ev!.signal, "screen");
    assert.equal(ev!.kind, "foreground-app");
    assert.equal(ev!.app, "Visual Studio Code");
    assert.equal(ev!.summary, "switched to Visual Studio Code");
    assert.equal(ev!.ts, NOW);
  });

  test("unchanged app → null", () => {
    assert.equal(shouldEmitForeground("Safari", { app: "Safari" }, NOW), null);
  });

  test("no app → null", () => {
    assert.equal(shouldEmitForeground("Safari", {}, NOW), null);
  });

  test("blacklisted app (password manager) → null (frame skipped)", () => {
    assert.equal(shouldEmitForeground("Safari", { app: "1Password" }, NOW), null);
    assert.equal(shouldEmitForeground("Safari", { app: "Chase Banking" }, NOW), null);
  });

  test("window title: secret-path dropped, PII redacted, normal kept", () => {
    const secret = shouldEmitForeground(undefined, { app: "Terminal", title: "vim /home/me/.env" }, NOW);
    assert.equal(secret!.title, undefined, "secret-path title dropped");

    const pii = shouldEmitForeground(undefined, { app: "Mail", title: "to alice@example.com" }, NOW);
    assert.equal(pii!.title, "to [email]", "PII in title redacted");

    const ok = shouldEmitForeground(undefined, { app: "Notes", title: "Grocery list" }, NOW);
    assert.equal(ok!.title, "Grocery list");
  });

  test("never carries raw screen content — only app/title/summary keys", () => {
    const ev = shouldEmitForeground(undefined, { app: "X", title: "y" }, NOW)!;
    assert.deepEqual(
      Object.keys(ev).sort(),
      ["app", "kind", "signal", "summary", "title", "ts"].sort(),
    );
  });
});

describe("ScreenSource (consent-gated, change-detecting)", () => {
  function probeSeq(seq: Array<{ app?: string; title?: string }>): ForegroundProbe {
    let i = 0;
    return async () => seq[Math.min(i++, seq.length - 1)] ?? {};
  }

  test("captures nothing when consent is not granted", async () => {
    const emitted: SenseEvent[] = [];
    const src = new ScreenSource({
      granted: () => false,
      probe: probeSeq([{ app: "Safari" }]),
      now: () => NOW,
    });
    await src.start((e) => emitted.push(e));
    await src.tick();
    await src.stop();
    assert.equal(emitted.length, 0);
  });

  test("emits once per change when granted", async () => {
    const emitted: SenseEvent[] = [];
    const src = new ScreenSource({
      granted: () => true,
      probe: probeSeq([{ app: "Safari" }, { app: "Safari" }, { app: "Code" }]),
      now: () => NOW,
    });
    await src.start((e) => emitted.push(e));
    await src.tick(); // Safari (new)
    await src.tick(); // Safari (no change)
    await src.tick(); // Code (change)
    await src.stop();
    assert.deepEqual(emitted.map((e) => e.app), ["Safari", "Code"]);
  });

  test("switching THROUGH a blacklisted app leaves no trace and no false change", async () => {
    const emitted: SenseEvent[] = [];
    const src = new ScreenSource({
      granted: () => true,
      probe: probeSeq([{ app: "Safari" }, { app: "1Password" }, { app: "Safari" }]),
      now: () => NOW,
    });
    await src.start((e) => emitted.push(e));
    await src.tick(); // Safari
    await src.tick(); // 1Password → skipped, prev stays Safari
    await src.tick(); // Safari → unchanged vs prev → no event
    await src.stop();
    assert.deepEqual(emitted.map((e) => e.app), ["Safari"]);
  });

  test("a mid-run revoke stops emission and forgets context", async () => {
    const emitted: SenseEvent[] = [];
    let allow = true;
    const src = new ScreenSource({
      granted: () => allow,
      probe: probeSeq([{ app: "Safari" }, { app: "Code" }, { app: "Code" }]),
      now: () => NOW,
    });
    await src.start((e) => emitted.push(e));
    await src.tick(); // Safari
    allow = false;
    await src.tick(); // revoked → nothing, prev reset
    allow = true;
    await src.tick(); // Code, but prev was reset → counts as new → 1 event
    await src.stop();
    assert.deepEqual(emitted.map((e) => e.app), ["Safari", "Code"]);
  });
});
