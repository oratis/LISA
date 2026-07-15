import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DesireEntry } from "./types.js";

// PLAN_DESIRE_EVOLUTION_v1.0 §3 PR3: pick-desire.test.ts covers the PURE
// pickCurrentDesire; this covers the I/O half — desireActivity reading real
// file mtimes off disk and feeding pickCurrentDesire end-to-end. Uses a real
// temp soul with mtimes pinned via fs.utimes so the assertions are deterministic.
//
// SOUL_DIR derives from LISA_HOME at import, so set a tmp home before importing.
let store: typeof import("./store.js");
let paths: typeof import("./paths.js");
let home: string;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-desire-activity-"));
  process.env.LISA_HOME = home;
  store = await import("./store.js");
  paths = await import("./paths.js");
  await store.ensureSoulDirs();
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const iso = (s: string) => new Date(s).getTime() / 1000; // fs.utimes wants seconds

async function seed(slug: string, bornAt: string) {
  await store.writeDesire({
    slug,
    what: slug,
    why: "",
    actionable: true,
    heartbeatPrompt: "pursue it",
    bornAt,
  });
}

describe("desireActivity (real fs.stat I/O)", () => {
  test("reports the newer of the desire-file and progress-file mtime, per slug", async () => {
    await seed("alpha", "2026-01-01T00:00:00.000Z");
    await seed("beta", "2026-01-01T00:00:00.000Z");
    // beta has been PURSUED recently (progress file appended), alpha hasn't.
    await store.appendDesireProgress("beta", "did a thing");

    // Pin mtimes deterministically: alpha's files old; beta's desire file old
    // but its progress file fresh — so beta's activity should win.
    await fsp.utimes(paths.desireFile("alpha"), iso("2026-02-01"), iso("2026-02-01"));
    await fsp.utimes(paths.desireFile("beta"), iso("2026-02-01"), iso("2026-02-01"));
    await fsp.utimes(paths.desireProgressFile("beta"), iso("2026-08-01"), iso("2026-08-01"));

    const desires = await store.listDesires();
    const activity = await store.desireActivity(desires);

    // beta's activity reflects its fresh PROGRESS mtime (pursuit), not its older
    // desire-file mtime.
    assert.equal(activity["beta"]?.slice(0, 7), "2026-08");
    assert.equal(activity["alpha"]?.slice(0, 7), "2026-02");

    // End-to-end: the recently-pursued desire is surfaced as current.
    assert.equal(store.pickCurrentDesire(desires, activity)?.slug, "beta");
  });

  test("floors at bornAt when no files are newer (and tolerates a missing progress file)", async () => {
    // 'gamma' has a future bornAt but its files will be stat'd at creation time
    // (now), which is < the future bornAt — so activity should floor at bornAt.
    await seed("gamma", "2099-01-01T00:00:00.000Z");
    const desires = (await store.listDesires()).filter((d) => d.slug === "gamma");
    const activity = await store.desireActivity(desires);
    // Missing progress file is not an error; bornAt dominates.
    assert.equal(activity["gamma"]?.slice(0, 4), "2099");
  });

  test("tolerates an unsafe slug from a stray file instead of rejecting the scan", async () => {
    // listDesires() derives slugs from raw filenames without validating, so a
    // stray file (e.g. a macOS '._x.md' AppleDouble in the git-synced soul dir)
    // yields a dot-leading slug that desireFile()'s assertSafeSlug rejects.
    // desireActivity must skip it and floor at bornAt — not throw (which would
    // abort `lisa status`).
    const unsafe: DesireEntry = {
      slug: "._applesauce",
      what: "stray",
      why: "",
      actionable: false,
      bornAt: "2026-03-01T00:00:00.000Z",
    };
    const activity = await store.desireActivity([unsafe]); // must not throw
    assert.equal(activity["._applesauce"]?.slice(0, 7), "2026-03");
  });
});
