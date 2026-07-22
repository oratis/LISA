import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-tenancy-"));
process.env.LISA_HOME = TMP;
// Soul git history is irrelevant here and just slows the writes down.
process.env.LISA_SOUL_NO_GIT = "1";

const { lisaHome, lisaGlobalHome, homeScope, homeForUid, sessionsDir } = await import("../paths.js");
const soulPaths = await import("../soul/paths.js");
const soulStore = await import("../soul/store.js");

const HOME_A = homeForUid("apple-001.aaa");
const HOME_B = homeForUid("em-bbbbbbbbbbbbbbbbbb");

describe("per-uid home scope (B2)", () => {
  test("outside any scope, lisaHome == the global home", () => {
    assert.equal(lisaHome(), TMP);
    assert.equal(lisaGlobalHome(), TMP);
  });

  test("homeForUid nests under <global>/users/<uid>", () => {
    assert.equal(HOME_A, path.join(TMP, "users", "apple-001.aaa"));
  });

  test("inside a scope every path helper resolves into that user's subtree", () => {
    homeScope.run(HOME_A, () => {
      assert.equal(lisaHome(), HOME_A);
      assert.ok(soulPaths.soulDir().startsWith(HOME_A));
      assert.ok(sessionsDir().startsWith(HOME_A));
      // The operator home is NOT rescoped — config/accounts stay global.
      assert.equal(lisaGlobalHome(), TMP);
    });
    // Scope does not leak once run() returns.
    assert.equal(lisaHome(), TMP);
  });

  test("the scope survives awaits (async continuations keep their home)", async () => {
    await homeScope.run(HOME_A, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(lisaHome(), HOME_A);
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(soulPaths.soulJournalDir().startsWith(HOME_A));
    });
  });

  test("two tenants write souls that land in disjoint subtrees", async () => {
    await homeScope.run(HOME_A, async () => {
      await soulStore.ensureSoulDirs();
      await soulStore.writeName("Aria");
    });
    await homeScope.run(HOME_B, async () => {
      await soulStore.ensureSoulDirs();
      await soulStore.writeName("Belle");
    });
    // On-disk isolation:
    const nameA = fs.readFileSync(path.join(HOME_A, "soul", "name.md"), "utf8");
    const nameB = fs.readFileSync(path.join(HOME_B, "soul", "name.md"), "utf8");
    assert.match(nameA, /Aria/);
    assert.match(nameB, /Belle/);
    // Cross-tenant read impossible through the store:
    await homeScope.run(HOME_A, async () => {
      assert.equal(await soulStore.readName(), "Aria");
    });
    await homeScope.run(HOME_B, async () => {
      assert.equal(await soulStore.readName(), "Belle");
    });
    // The global home saw neither soul.
    assert.equal(fs.existsSync(path.join(TMP, "soul", "name.md")), false);
  });

  test("isBorn is scoped: born in A, unborn in B and globally", async () => {
    await homeScope.run(HOME_A, async () => {
      await soulStore.writeSeed({
        bornAt: new Date().toISOString(),
        bigFive: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
      } as never);
      assert.equal(await soulStore.isBorn(), true);
    });
    await homeScope.run(HOME_B, async () => {
      assert.equal(await soulStore.isBorn(), false);
    });
    assert.equal(await soulStore.isBorn(), false);
  });
});
