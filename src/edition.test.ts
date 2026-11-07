import { test } from "node:test";
import assert from "node:assert/strict";
import {
  edition,
  isCloud,
  editionInfo,
  MAC_ONLY_CAPABILITIES,
  cloudLegacyTokenAllowed,
} from "./edition.js";

test("edition defaults to mac; cloud only when LISA_EDITION=cloud", () => {
  assert.equal(edition({}), "mac");
  assert.equal(edition({ LISA_EDITION: "" }), "mac");
  assert.equal(edition({ LISA_EDITION: "macbook" }), "mac");
  assert.equal(edition({ LISA_EDITION: "cloud" }), "cloud");
  assert.equal(isCloud({ LISA_EDITION: "cloud" }), true);
  assert.equal(isCloud({}), false);
});

test("editionInfo hides Mac-only capabilities in cloud, none on mac", () => {
  assert.deepEqual(editionInfo({}), { edition: "mac", macOnlyDisabled: [] });
  const cloud = editionInfo({ LISA_EDITION: "cloud" });
  assert.equal(cloud.edition, "cloud");
  assert.deepEqual(cloud.macOnlyDisabled, MAC_ONLY_CAPABILITIES);
});

test("the shared token is refused in the hosted edition unless the operator opts in", () => {
  assert.equal(cloudLegacyTokenAllowed({}), false);
  assert.equal(cloudLegacyTokenAllowed({ LISA_CLOUD_SHARED_TOKEN_OK: "" }), false);
  assert.equal(cloudLegacyTokenAllowed({ LISA_CLOUD_SHARED_TOKEN_OK: "0" }), false);
  for (const on of ["1", "true", "YES", " on "]) {
    assert.equal(cloudLegacyTokenAllowed({ LISA_CLOUD_SHARED_TOKEN_OK: on }), true, on);
  }
});
