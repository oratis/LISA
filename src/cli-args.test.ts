import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./cli-args.js";

describe("parseArgs — raw / passthrough subcommand routing", () => {
  test("mail: every trailing flag reaches the handler verbatim, even would-be global ones", () => {
    const a = parseArgs([
      "mail", "connect",
      "--email", "me@gmail.com",
      "--host", "imap.gmail.com",
      "--port", "993",
      "--provider", "gmail",
    ]);
    assert.equal(a.subcommand, "mail");
    assert.deepEqual(a.subargs, [
      "connect",
      "--email", "me@gmail.com",
      "--host", "imap.gmail.com",
      "--port", "993",
      "--provider", "gmail",
    ]);
    // …and none of those were consumed as global settings:
    assert.equal(a.host, "127.0.0.1");
    assert.equal(a.port, 5757);
  });

  test("kb: passthrough — its --title/--tags/--force flags reach the handler verbatim", () => {
    const a = parseArgs(["kb", "add", "https://x.dev/a", "--title", "T", "--tags", "a,b", "--force"]);
    assert.equal(a.subcommand, "kb");
    assert.deepEqual(a.subargs, ["add", "https://x.dev/a", "--title", "T", "--tags", "a,b", "--force"]);
  });

  test("autostart: recognized global flags are parsed into the global fields (not swallowed)", () => {
    const a = parseArgs([
      "autostart", "install",
      "--port", "8080",
      "--channels", "imessage,sms",
      "--imessage",
    ]);
    assert.equal(a.subcommand, "autostart");
    assert.deepEqual(a.subargs, ["install"]);
    assert.equal(a.port, 8080);
    assert.deepEqual(a.serveChannels, ["imessage", "sms"]);
    assert.equal(a.serveImessage, true);
  });

  test("autostart: an unrecognized flag is still collected verbatim for the handler", () => {
    const a = parseArgs(["autostart", "install", "--no-load"]);
    assert.deepEqual(a.subargs, ["install", "--no-load"]);
  });

  test("heartbeat: --model is parsed globally, not swallowed into subargs", () => {
    const a = parseArgs(["heartbeat", "run", "--model", "claude-test"]);
    assert.equal(a.subcommand, "heartbeat");
    assert.deepEqual(a.subargs, ["run"]);
    assert.equal(a.model, "claude-test");
    assert.equal(a.modelExplicit, true);
  });

  test("global flags before the subcommand still apply", () => {
    const a = parseArgs(["--model", "claude-test", "mail", "connect", "--email", "me@x.com"]);
    assert.equal(a.model, "claude-test");
    assert.equal(a.subcommand, "mail");
    assert.deepEqual(a.subargs, ["connect", "--email", "me@x.com"]);
  });

  test("an unknown flag in global position throws", () => {
    assert.throws(() => parseArgs(["--totallybogus"]), /unknown flag: --totallybogus/);
  });

  test("a flag value that happens to match a subcommand name is not misread as a subcommand", () => {
    // --model consumes its value, so 'mail' here is the model, not a subcommand.
    const a = parseArgs(["--model", "mail", "hello", "world"]);
    assert.equal(a.model, "mail");
    assert.equal(a.subcommand, undefined);
    assert.equal(a.prompt, "hello world");
  });
});
