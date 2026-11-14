import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalCodex } from "./codex.js";

// A native protocol fixture exercises the actual process group, environment and
// Seatbelt boundary. It makes no model call and deliberately tries forbidden I/O.
test(
  "Codex reviews isolate source files and credentials, validate completion, and cancel the process",
  {
    skip: process.platform !== "darwin",
    timeout: 30000,
  },
  async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-")));
    const source = path.join(dir, "source"),
      home = path.join(dir, "lisa"),
      binary = path.join(dir, "codex");
    fs.mkdirSync(source);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(source, "secret.txt"), "must not be read");
    const c = path.join(dir, "fixture.c");
    fs.writeFileSync(
      c,
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char input[4096] = {0}; fread(input, 1, sizeof(input)-1, stdin);
  if (!strcmp(input, "hang")) { sleep(30); return 0; }
  if (!strcmp(input, "broken")) { puts("not-json"); return 0; }
  if (!strcmp(input, "incomplete")) { puts("{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"partial\\"}}"); return 0; }
  FILE *leak = fopen(${JSON.stringify(path.join(source, "secret.txt"))}, "r");
  FILE *write = fopen(${JSON.stringify(path.join(source, "modified.txt"))}, "w");
  if (leak || write || getenv("FLEET_TEST_SECRET")) return 13;
  int flags = 0;
  for (int i=1; i<argc; i++) if (!strcmp(argv[i], "--ephemeral") || !strcmp(argv[i], "--ignore-user-config") || !strcmp(argv[i], "read-only") || !strcmp(argv[i], "features.shell_tool=false")) flags++;
  if (flags != 4) return 14;
  puts("{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"reviewed only the packet\\"}}");
  puts("{\\"type\\":\\"turn.completed\\"}"); return 0;
}`,
    );
    execFileSync("cc", [c, "-o", binary], { stdio: "pipe" });
    const previous = {
      LISA_PTY_CODEX_CMD: process.env.LISA_PTY_CODEX_CMD,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      FLEET_TEST_SECRET: process.env.FLEET_TEST_SECRET,
    };
    Object.assign(process.env, {
      LISA_PTY_CODEX_CMD: binary,
      OPENAI_API_KEY: "fixture-not-a-key",
      FLEET_TEST_SECRET: "must-not-inherit",
    });
    try {
      const runner = new LocalCodex(home, 18799);
      assert.equal(runner.reason(), null);
      for (const prompt of ["review packet", "broken", "incomplete", "hang"]) {
        const results: { text: string; error: boolean }[] = [];
        let resolve!: (value: string) => void;
        const ended = new Promise<string>((r) => {
          resolve = r;
        });
        const session = runner.start(source, {
          approval() {
            assert.fail("review cannot approve");
          },
          result: (text, error) => {
            results.push({ text, error });
          },
          exit: resolve,
        });
        session.send(prompt);
        assert.throws(() => session.send("repeat"), /append_unavailable/);
        assert.throws(() => session.decide("old-approval", true), /approval_unavailable/);
        if (prompt === "hang") session.cancel();
        const exit = await ended;
        if (prompt === "review packet") {
          assert.equal(exit, "");
          assert.deepEqual(results, [{ text: "reviewed only the packet", error: false }]);
        } else {
          assert.notEqual(exit, "");
          assert.ok(
            results.every((r) => r.error),
            "partial/malformed output cannot become a successful result",
          );
        }
      }
      assert.equal(fs.existsSync(path.join(source, "modified.txt")), false);
      assert.equal(fs.readFileSync(path.join(source, "secret.txt"), "utf8"), "must not be read");
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
