import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { displayPath } from "./display-path.js";

describe("displayPath", () => {
  const home = "/Users/alice";

  test("collapses a child of $HOME to ~/…", () => {
    assert.equal(displayPath("/Users/alice/.lisa/config.env", home), "~/.lisa/config.env");
  });

  test("$HOME itself becomes ~", () => {
    assert.equal(displayPath("/Users/alice", home), "~");
  });

  test("a sibling that merely shares the prefix is left alone", () => {
    assert.equal(displayPath("/Users/alicefoo/.lisa", home), "/Users/alicefoo/.lisa");
  });

  test("paths outside $HOME are unchanged", () => {
    assert.equal(displayPath("/opt/homebrew/bin/lisa", home), "/opt/homebrew/bin/lisa");
  });

  test("tolerates a trailing separator on $HOME", () => {
    assert.equal(displayPath("/Users/alice/.lisa", "/Users/alice/"), "~/.lisa");
  });

  test("empty input and empty home are passthrough", () => {
    assert.equal(displayPath("", home), "");
    assert.equal(displayPath("/x/y", ""), "/x/y");
    assert.equal(displayPath("/x/y", "/"), "/x/y");
  });
});
