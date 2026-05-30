import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildScreencaptureArgs, captureSupported } from "./capture.js";

describe("buildScreencaptureArgs", () => {
  test("interactive mode → -x -i -o <path>", () => {
    const args = buildScreencaptureArgs("interactive", "/tmp/shot.png");
    assert.deepEqual(args, ["-x", "-i", "-o", "/tmp/shot.png"]);
  });

  test("full mode → -x <path> (no -i)", () => {
    const args = buildScreencaptureArgs("full", "/tmp/shot.png");
    assert.deepEqual(args, ["-x", "/tmp/shot.png"]);
  });

  test("output path is always the LAST argument", () => {
    for (const mode of ["interactive", "full"] as const) {
      const args = buildScreencaptureArgs(mode, "/tmp/x.png");
      assert.equal(args[args.length - 1], "/tmp/x.png");
    }
  });

  test("always silences the shutter (-x present)", () => {
    assert.ok(buildScreencaptureArgs("interactive", "/p").includes("-x"));
    assert.ok(buildScreencaptureArgs("full", "/p").includes("-x"));
  });

  test("the path is a single argv element — no shell, no injection surface", () => {
    const tricky = "/tmp/a b; rm -rf ~/.png";
    const args = buildScreencaptureArgs("full", tricky);
    assert.equal(args[args.length - 1], tricky, "path passed verbatim as one arg");
  });
});

describe("captureSupported", () => {
  test("matches the platform (darwin only)", () => {
    assert.equal(captureSupported(), process.platform === "darwin");
  });
});
