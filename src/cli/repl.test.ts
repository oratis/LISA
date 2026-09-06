import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { runRepl, type ReplHandlers } from "./repl.js";
import { loadHistory, saveHistory } from "./history.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-repl-"));
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * Drive the REPL with a pair of in-memory streams. `lines` are fed as if typed;
 * the input then ends, which closes readline the way Ctrl-D does.
 */
async function drive(
  lines: string[],
  opts: { historyFile?: string | null } = {},
): Promise<{ prompts: string[]; slashes: [string, string][]; out: string; closed: boolean }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const prompts: string[] = [];
  const slashes: [string, string][] = [];
  let closed = false;
  const handlers: ReplHandlers = {
    onLine: async (line) => void prompts.push(line),
    onSlash: async (cmd, args) => {
      slashes.push([cmd, args]);
      return cmd !== "bogus";
    },
    onClose: async () => {
      closed = true;
    },
  };
  const done = runRepl(handlers, {
    input,
    output,
    terminal: true,
    historyFile: opts.historyFile ?? null,
  });
  for (const l of lines) input.write(l + "\n");
  input.end();
  await done;
  // Leave no open handles behind — node:test on CI fails the run otherwise.
  output.end();
  input.destroy();
  output.destroy();
  return { prompts, slashes, out: chunks.join(""), closed };
}

describe("runRepl — streams are injectable", () => {
  test("plain lines reach onLine; onClose runs at EOF", async () => {
    const r = await drive(["hello", "  ", "world  "]);
    assert.deepEqual(r.prompts, ["hello", "world"]);
    assert.equal(r.closed, true);
  });

  test("slash commands are split into command and args", async () => {
    const r = await drive(["/think", "/save a note here"]);
    assert.deepEqual(r.slashes, [
      ["think", ""],
      ["save", "a note here"],
    ]);
    assert.deepEqual(r.prompts, []);
  });

  test("an unhandled slash command reports on the injected output, not stderr", async () => {
    const r = await drive(["/bogus"]);
    assert.match(r.out, /unknown command: \/bogus/);
  });

  test('""" collects a multi-line prompt', async () => {
    const r = await drive(['"""', "line one", "line two", '"""']);
    assert.deepEqual(r.prompts, ["line one\nline two"]);
    assert.match(r.out, /multi-line mode/);
  });
});

describe("runRepl — persistent history", () => {
  test("earlier prompts are loaded and this session's are appended", async () => {
    const file = path.join(tmp, "history");
    await saveHistory(["older prompt"], file);
    await drive(["first", "second", "second"], { historyFile: file });
    // Oldest-first on disk, duplicates collapsed.
    assert.deepEqual(await loadHistory(file), ["older prompt", "first", "second"]);
  });

  test("slash commands and blanks are recorded too, but never empty lines", async () => {
    const file = path.join(tmp, "history-slash");
    await drive(["/think", "", "  "], { historyFile: file });
    assert.deepEqual(await loadHistory(file), ["/think"]);
  });

  test("historyFile: null writes nothing", async () => {
    const file = path.join(tmp, "history-disabled");
    await drive(["secret prompt"], { historyFile: null });
    await assert.rejects(fs.stat(file));
  });
});
