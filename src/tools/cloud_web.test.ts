import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_WEB_TOOL_NAMES, cloudWebToolsEnabled } from "./cloud_web.js";

describe("cloud web tools — kill switch", () => {
  test("is on unless explicitly switched off", () => {
    assert.equal(cloudWebToolsEnabled({}), true);
    assert.equal(cloudWebToolsEnabled({ LISA_CLOUD_WEB_TOOLS: "1" }), true);
    for (const off of ["0", "false", "off", "no", " OFF "]) {
      assert.equal(cloudWebToolsEnabled({ LISA_CLOUD_WEB_TOOLS: off }), false, off);
    }
  });

  test("governs exactly the two outbound web tools", () => {
    assert.deepEqual([...CLOUD_WEB_TOOL_NAMES].sort(), ["web_fetch", "web_search"]);
  });
});
