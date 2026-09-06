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

describe("autostart plist logging (T-6)", () => {
  const plist = renderPlist({
    label: "ai.lisa.autostart",
    argv: ["/usr/local/bin/lisa", "serve", "--web"],
    logPath: "/Users/x/.lisa/serve.launchd.log",
    env: { LISA_LOG_FILE: "/Users/x/.lisa/serve.log" },
  });

  test("launchd captures stdout/stderr into the *raw* log, not the rotated one", () => {
    // If these pointed at serve.log, launchd would append to the same file the
    // process rotates out from under it and the rotation would leak an fd.
    assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/Users\/x\/\.lisa\/serve\.launchd\.log<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/x\/\.lisa\/serve\.launchd\.log<\/string>/);
  });

  test("LISA_LOG_FILE is exported so the process owns rotation of the main log", () => {
    assert.match(plist, /<key>LISA_LOG_FILE<\/key>\s*<string>\/Users\/x\/\.lisa\/serve\.log<\/string>/);
  });

  test("the PATH default survives alongside injected env vars", () => {
    assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:/);
  });

  test("env keys and values are XML-escaped", () => {
    const p = renderPlist({
      label: "l",
      argv: ["/bin/lisa"],
      logPath: "/l",
      env: { LISA_LOG_FILE: "/tmp/a&b.log" },
    });
    assert.match(p, /a&amp;b\.log/);
    assert.doesNotMatch(p, /a&b/);
  });

  test("no env option ⇒ the plist is exactly the PATH-only dict as before", () => {
    const p = renderPlist({ label: "l", argv: ["/bin/lisa"], logPath: "/l" });
    assert.doesNotMatch(p, /LISA_LOG_FILE/);
    assert.match(p, /<key>PATH<\/key>/);
  });
});
