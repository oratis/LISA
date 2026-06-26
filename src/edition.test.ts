import { test } from "node:test";
import assert from "node:assert/strict";
import { edition, isCloud, editionInfo, MAC_ONLY_CAPABILITIES } from "./edition.js";

test("edition defaults to mac; cloud only when LISA_EDITION=cloud", () => {
  assert.equal(edition({} as NodeJS.ProcessEnv), "mac");
  assert.equal(edition({ LISA_EDITION: "" } as NodeJS.ProcessEnv), "mac");
  assert.equal(edition({ LISA_EDITION: "macbook" } as NodeJS.ProcessEnv), "mac");
  assert.equal(edition({ LISA_EDITION: "cloud" } as NodeJS.ProcessEnv), "cloud");
  assert.equal(isCloud({ LISA_EDITION: "cloud" } as NodeJS.ProcessEnv), true);
  assert.equal(isCloud({} as NodeJS.ProcessEnv), false);
});

test("editionInfo hides Mac-only capabilities in cloud, none on mac", () => {
  assert.deepEqual(editionInfo({} as NodeJS.ProcessEnv), { edition: "mac", macOnlyDisabled: [] });
  const cloud = editionInfo({ LISA_EDITION: "cloud" } as NodeJS.ProcessEnv);
  assert.equal(cloud.edition, "cloud");
  assert.deepEqual(cloud.macOnlyDisabled, MAC_ONLY_CAPABILITIES);
});
