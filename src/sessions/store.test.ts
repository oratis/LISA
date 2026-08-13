import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredMessage } from "../types.js";

// sessionsDir() is resolved from lisaHome() at import time, so set a tmp home
// BEFORE importing the store (dynamic import). node --test isolates each file in
// its own process, so this env mutation can't leak to other suites.
let SessionStore: typeof import("./store.js").SessionStore;
let promptFingerprint: typeof import("./store.js").promptFingerprint;
let home: string;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-sess-"));
  process.env.LISA_HOME = home;
  ({ SessionStore, promptFingerprint } = await import("./store.js"));
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function msg(i: number): StoredMessage {
  return { role: i % 2 === 0 ? "user" : "assistant", content: "m" + i };
}

describe("SessionStore — create / open round-trip", () => {
  test("create writes a header that open() reads back", async () => {
    const s = await SessionStore.create({ cwd: "/work/proj", model: "test-model" });
    assert.equal(s.header.type, "session");
    assert.equal(s.header.cwd, "/work/proj");
    assert.equal(s.header.model, "test-model");

    const reopened = await SessionStore.open(s.id);
    assert.equal(reopened.id, s.id);
    assert.equal(reopened.header.cwd, "/work/proj");
    assert.equal(reopened.header.model, "test-model");
  });

  test("open() rejects a missing session", async () => {
    await assert.rejects(SessionStore.open("does-not-exist"));
  });

  test("open() rejects an empty session file", async () => {
    const empty = path.join(home, "sessions", "empty-one.jsonl");
    fs.mkdirSync(path.dirname(empty), { recursive: true });
    fs.writeFileSync(empty, "");
    await assert.rejects(SessionStore.open("empty-one"), /empty/);
  });
});

describe("SessionStore — message persistence + resume", () => {
  test("appended messages come back in chronological order", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    for (let i = 0; i < 3; i++) await s.appendMessage(msg(i));

    // Resume from disk (the real path: a fresh process re-opens by id).
    const resumed = await SessionStore.open(s.id);
    const page = await resumed.readMessagePage(0);
    assert.deepEqual(page.messages.map((m) => m.content), ["m0", "m1", "m2"]);
    assert.equal(page.hasMore, false);
  });

  test("reflections do not appear in message pages", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    await s.appendMessage(msg(0));
    await s.appendReflection("a private reflection");
    await s.appendReflection("the latest reflection");
    await s.appendMessage(msg(1));
    const page = await s.readMessagePage(0);
    assert.deepEqual(page.messages.map((m) => m.content), ["m0", "m1"]);
    assert.equal(await s.readLatestReflection(), "the latest reflection");
  });

  test("pagination: latest page first, chronological within a page, hasMore set", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    for (let i = 0; i < 25; i++) await s.appendMessage(msg(i));

    const p0 = await s.readMessagePage(0, 20);
    assert.equal(p0.messages.length, 20);
    assert.equal(p0.messages[0]!.content, "m5", "page 0 starts at the 6th-from-newest");
    assert.equal(p0.messages[19]!.content, "m24", "page 0 ends at the newest");
    assert.equal(p0.hasMore, true);

    const p1 = await s.readMessagePage(1, 20);
    assert.deepEqual(p1.messages.map((m) => m.content), ["m0", "m1", "m2", "m3", "m4"]);
    assert.equal(p1.hasMore, false);
  });

  test("reading past the end returns empty, not an error", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    await s.appendMessage(msg(0));
    const page = await s.readMessagePage(5, 20);
    assert.deepEqual(page.messages, []);
    assert.equal(page.hasMore, false);
  });
});

// H3 — "model-visible ⟺ recorded" (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §4).
describe("SessionStore — system prompt persistence", () => {
  function promptEntries(file: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "prompt");
  }

  test("new sessions declare format version 2", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    assert.equal(s.header.version, 2);
  });

  test("first prompt is written with reason 'initial' and a content fingerprint", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    assert.equal(await s.appendPrompt("You are Lisa.", "initial"), true);

    const entries = promptEntries(s.path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, "You are Lisa.");
    assert.equal(entries[0]!.reason, "initial");
    assert.equal(entries[0]!.fingerprint, promptFingerprint("You are Lisa."));
  });

  test("an unchanged prompt is not re-written on every turn", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    await s.appendPrompt("stable", "initial");
    assert.equal(await s.appendPrompt("stable", "rebuilt"), false);
    assert.equal(await s.appendPrompt("stable", "rebuilt"), false);
    assert.equal(promptEntries(s.path).length, 1);
  });

  test("a changed prompt is written again, and back-and-forth changes both land", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    await s.appendPrompt("v1", "initial");
    await s.appendPrompt("v2", "rebuilt");
    await s.appendPrompt("v1", "rebuilt"); // reverting is still a change
    assert.deepEqual(
      promptEntries(s.path).map((e) => e.text),
      ["v1", "v2", "v1"],
    );
  });

  test("resuming a session does not duplicate the prompt still in effect", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    await s.appendPrompt("carried over", "initial");
    await s.appendMessage(msg(0));

    const resumed = await SessionStore.open(s.id);
    assert.equal(
      await resumed.appendPrompt("carried over", "initial"),
      false,
      "the prompt is unchanged since the last run — nothing new to record",
    );
    assert.equal(promptEntries(s.path).length, 1);

    assert.equal(await resumed.appendPrompt("she patched herself", "rebuilt"), true);
    assert.equal(promptEntries(s.path).length, 2);
  });

  test("prompt entries stay out of message pages and reflections", async () => {
    const s = await SessionStore.create({ cwd: "/w", model: "m" });
    await s.appendPrompt("persona", "initial");
    await s.appendMessage(msg(0));
    await s.appendPrompt("persona v2", "rebuilt");
    await s.appendMessage(msg(1));

    const page = await s.readMessagePage(0);
    assert.deepEqual(page.messages.map((m) => m.content), ["m0", "m1"]);
    assert.equal(await s.readLatestReflection(), undefined);
  });
});
