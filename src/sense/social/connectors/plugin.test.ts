import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { discoverSocialConnectors } from "../manifest.js";
import { installBundledOpenConnector } from "./plugin.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("installs discoverable connector plugins with a safety-constrained skill", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-plugin-"));
  roots.push(root);
  await installBundledOpenConnector("bluesky", false, root);
  await installBundledOpenConnector("mastodon", false, root);
  const found = await discoverSocialConnectors(root);
  assert.deepEqual(found.map((item) => item.manifest?.id), [
    "bluesky-official",
    "mastodon-official",
  ]);
  const skill = fs.readFileSync(
    path.join(root, "lisa-social-bluesky", "skills", "bluesky-publisher", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /Never call a publish operation/);
  assert.doesNotMatch(skill, /accessJwt|refreshJwt|app-password/i);
});
