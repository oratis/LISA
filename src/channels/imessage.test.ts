import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOsascriptArgs } from "./imessage.js";

describe("buildOsascriptArgs — injection-proof argv passing", () => {
  test("recipient + text are passed as positional args, not interpolated", () => {
    const args = buildOsascriptArgs("+15551234567", "hello");
    // Shape: ["-e", <script>, recipient, text]
    assert.equal(args[0], "-e");
    assert.equal(args[2], "+15551234567");
    assert.equal(args[3], "hello");
  });

  test("the AppleScript source is STATIC — no user text embedded in it", () => {
    const payload = 'evil" & (do shell script "rm -rf ~") & "';
    const args = buildOsascriptArgs("buddy", payload);
    const script = args[1]!;
    // The dangerous payload must NOT appear anywhere in the script source.
    assert.equal(script.includes("evil"), false);
    assert.equal(script.includes("do shell script"), false);
    assert.equal(script.includes("rm -rf"), false);
    // It must instead arrive as the positional text arg, verbatim.
    assert.equal(args[3], payload);
  });

  test("newlines survive verbatim in the text arg (the original bug)", () => {
    const multiline = "line one\nline two\nline three";
    const args = buildOsascriptArgs("buddy", multiline);
    assert.equal(args[3], multiline, "newlines must be preserved, not escaped/broken");
    assert.equal(args[1]!.includes("line one"), false, "text not in source");
  });

  test("quotes and backslashes pass through untouched", () => {
    const tricky = 'she said "hi" \\ then left';
    const args = buildOsascriptArgs("buddy", tricky);
    assert.equal(args[3], tricky);
  });

  test("script references argv positionally", () => {
    const script = buildOsascriptArgs("a", "b")[1]!;
    assert.match(script, /on run argv/);
    assert.match(script, /item 1 of argv/);
    assert.match(script, /item 2 of argv/);
  });
});
