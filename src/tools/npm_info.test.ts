import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatView, formatOutdated, formatAudit } from "./npm_info.js";

describe("npm_info formatView", () => {
  test("renders name@version + metadata", () => {
    const out = formatView(JSON.stringify({ name: "sharp", version: "0.34.5", description: "image lib", license: "Apache-2.0", homepage: "https://sharp.pixelplumbing.com" }));
    assert.match(out, /sharp@0\.34\.5/);
    assert.match(out, /license: Apache-2\.0/);
    assert.match(out, /homepage:/);
  });
  test("flags deprecation and picks newest from an array", () => {
    const out = formatView(JSON.stringify([{ name: "x", version: "1.0.0" }, { name: "x", version: "1.2.0", deprecated: "use y" }]));
    assert.match(out, /x@1\.2\.0/);
    assert.match(out, /DEPRECATED: use y/);
  });
});

describe("npm_info formatOutdated", () => {
  test("up to date", () => assert.match(formatOutdated("{}"), /up to date/));
  test("lists current → latest", () => {
    const out = formatOutdated(JSON.stringify({ react: { current: "18.0.0", latest: "19.0.0" } }));
    assert.match(out, /1 outdated/);
    assert.match(out, /react: 18\.0\.0 → 19\.0\.0/);
  });
});

describe("npm_info formatAudit", () => {
  test("clean", () => {
    assert.match(formatAudit(JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } } })), /no known vulnerabilities/);
  });
  test("summarises severities", () => {
    const out = formatAudit(JSON.stringify({ metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 3, info: 0 } } }));
    assert.match(out, /6 vulnerabilities: 1 critical, 2 high, 3 low/);
  });
});
