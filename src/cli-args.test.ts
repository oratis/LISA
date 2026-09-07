import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isVerboseArgv, parseArgs } from "./cli-args.js";

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

  test("billing keeps its own flags: `billing reconcile --dry-run` reaches the handler", () => {
    // T-8: the reconciler's flags are money-adjacent — a swallowed --dry-run
    // would turn "show me what you would do" into "go do it".
    const args = parseArgs(["billing", "reconcile", "--dry-run", "--uid", "em-1"]);
    assert.deepEqual(args.subargs, ["reconcile", "--dry-run", "--uid", "em-1"]);
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

describe("parseArgs — verbosity", () => {
  test("--verbose sets verbose and is not treated as a prompt word", () => {
    const a = parseArgs(["--verbose", "hello"]);
    assert.equal(a.verbose, true);
    assert.equal(a.prompt, "hello");
  });

  test("verbose defaults to false without LISA_DEBUG", () => {
    const prev = process.env.LISA_DEBUG;
    delete process.env.LISA_DEBUG;
    try {
      assert.equal(parseArgs(["status"]).verbose, false);
    } finally {
      if (prev !== undefined) process.env.LISA_DEBUG = prev;
    }
  });
});

describe("isVerboseArgv", () => {
  test("--verbose anywhere in argv", () => {
    assert.equal(isVerboseArgv(["serve", "--web", "--verbose"], {}), true);
    assert.equal(isVerboseArgv(["serve", "--web"], {}), false);
  });

  test("LISA_DEBUG=1 (and any other truthy spelling) turns it on; 0/false/empty do not", () => {
    assert.equal(isVerboseArgv([], { LISA_DEBUG: "1" }), true);
    assert.equal(isVerboseArgv([], { LISA_DEBUG: "true" }), true);
    assert.equal(isVerboseArgv([], { LISA_DEBUG: "0" }), false);
    assert.equal(isVerboseArgv([], { LISA_DEBUG: "false" }), false);
    assert.equal(isVerboseArgv([], { LISA_DEBUG: "" }), false);
    assert.equal(isVerboseArgv([], {}), false);
  });
});
