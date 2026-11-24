import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { homeScope } from "../paths.js";
import { BUILTIN_RECIPES } from "./builtins.js";
import {
  exportTaskAsRecipe,
  installRecipe,
  listRecipes,
  signRecipe,
  validateRecipe,
  verifyRecipeSignature,
} from "./store.js";
import { RECIPE_SCHEMA_VERSION, type Recipe } from "./types.js";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-recipes-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("Recipe Gallery", () => {
  test("validates built-in recipes, verifies Ed25519 signatures, and rejects tampering or secrets", () => {
    for (const r of BUILTIN_RECIPES) {
      const check = validateRecipe(r);
      assert.equal(check.ok, true, r.id);
    }

    const kp = crypto.generateKeyPairSync("ed25519");
    const pubPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signed = signRecipe(BUILTIN_RECIPES[0]!, {
      keyId: "author-1",
      privateKey: kp.privateKey,
      publicKeyPem: pubPem,
    });
    assert.equal(verifyRecipeSignature(signed).valid, true);
    const validRes = validateRecipe(signed);
    assert.equal(validRes.ok, true);
    if (validRes.ok) assert.equal(validRes.verified, true);

    // Tampering invalidates the signature.
    const tampered: Recipe = { ...signed, name: "Tampered Name" };
    const tamperedRes = validateRecipe(tampered);
    assert.equal(tamperedRes.ok, false);

    // Embedded secret is refused.
    const withSecret: Recipe = {
      ...BUILTIN_RECIPES[0]!,
      id: "bad-secret",
      task: {
        ...BUILTIN_RECIPES[0]!.task,
        instruction: "Use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const secretRes = validateRecipe(withSecret);
    assert.equal(secretRes.ok, false);
  });

  test("installs recipes as disabled drafts and exports de-privatized recipes", async () => {
    const home = path.join(TMP, "home-recipes");
    fs.mkdirSync(home, { recursive: true });

    await homeScope.run(home, async () => {
      const list = await listRecipes(home);
      assert.ok(list.length >= BUILTIN_RECIPES.length);

      const dry = await installRecipe(BUILTIN_RECIPES[0]!, { dryRun: true, home });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.task, undefined);
      assert.ok(dry.permissions.tools.includes("kb_search"));

      const installed = await installRecipe(BUILTIN_RECIPES[0]!, { home });
      assert.ok(installed.task);
      assert.equal(installed.task.enabled, false);
      assert.equal(installed.task.createdDisabled, true);
      assert.equal(installed.task.state, "draft");
      assert.equal(installed.task.origin.kind, "recipe");

      const exported = await exportTaskAsRecipe(installed.task.id, { author: "Tester" });
      assert.equal(exported.version, RECIPE_SCHEMA_VERSION);
      assert.equal(exported.task.title, installed.task.title);
      assert.equal(validateRecipe(exported).ok, true);
    });
  });
});
