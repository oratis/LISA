import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderPlist, serveArgs } from "./install.js";

describe("autostart serveArgs", () => {
  test("defaults to `serve --web` with no port (uses the default 5757)", () => {
    assert.deepEqual(serveArgs({}), ["serve", "--web"]);
    assert.deepEqual(serveArgs({ port: 5757 }), ["serve", "--web"]);
  });

  test("appends a non-default port", () => {
    assert.deepEqual(serveArgs({ port: 6000 }), ["serve", "--web", "--port", "6000"]);
  });

  test("imessage shortcut maps to --channels imessage", () => {
    assert.deepEqual(serveArgs({ imessage: true }), ["serve", "--web", "--channels", "imessage"]);
  });

  test("channels list is joined", () => {
    assert.deepEqual(serveArgs({ channels: ["telegram", "discord"] }), [
      "serve",
      "--web",
      "--channels",
      "telegram,discord",
    ]);
  });
});

describe("autostart renderPlist", () => {
  const plist = renderPlist({
    label: "ai.lisa.autostart",
    argv: ["/usr/local/bin/lisa", "serve", "--web"],
    logPath: "/Users/x/.lisa/autostart.log",
  });

  test("is a login agent: RunAtLoad + KeepAlive both true", () => {
    // The two keys that make it start at login and survive a crash. A
    // regression on either silently breaks "auto" start.
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    // It must NOT carry the heartbeat's StartInterval (that would re-spawn
    // a second server every N seconds).
    assert.doesNotMatch(plist, /StartInterval/);
  });

  test("carries the label and the serve --web argv", () => {
    assert.match(plist, /<string>ai\.lisa\.autostart<\/string>/);
    assert.match(plist, /<string>serve<\/string>/);
    assert.match(plist, /<string>--web<\/string>/);
    assert.match(plist, /<string>\/usr\/local\/bin\/lisa<\/string>/);
  });

  test("escapes XML metacharacters in argv", () => {
    const p = renderPlist({
      label: "ai.lisa.autostart",
      argv: ["/path/a&b", "serve"],
      logPath: "/l",
    });
    assert.match(p, /a&amp;b/);
    assert.doesNotMatch(p, /a&b/);
  });
});
