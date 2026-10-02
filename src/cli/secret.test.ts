import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { parseArgs } from "../cli-args.js";
import { MemorySecretStore, SECRET_VALUE_MAX_BYTES, SecretStoreError } from "../warden/secrets.js";
import { promptHidden, readPipedValue, runSecretCommand, type PromptInput } from "./secret.js";

/** Built at runtime so no literal in this file looks like a real credential. */
const VALUE = ["cli", "value", "0001"].join("-");

function harness(value: string | null = VALUE) {
  const store = new MemorySecretStore(() => Date.UTC(2026, 9, 2, 12, 0));
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  let opened = 0;
  const run = (args: string[]) =>
    runSecretCommand(args, {
      openStore: () => {
        opened++;
        return store;
      },
      readValue: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(value);
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  const printed = () => [...out, ...err, ...prompts].join("\n");
  return { store, out, err, prompts, run, printed, opened: () => opened };
}

test("secret set: stores the value and never prints it", async () => {
  const h = harness();
  assert.equal(await h.run(["set", "gmail/work"]), 0);
  assert.equal(await h.store.get("gmail/work"), VALUE);
  assert.deepEqual(h.out, ["stored secret://gmail/work (memory)"]);
  assert.deepEqual(h.prompts, ["Value for secret://gmail/work (input hidden): "]);
  assert.equal(h.printed().includes(VALUE), false);
  assert.equal(await h.run(["set", "secret://gmail/work"]), 0);
  assert.equal(h.out[1], "updated secret://gmail/work (memory)");
});

test("secret set: refuses a value on the command line", async () => {
  const h = harness();
  assert.equal(await h.run(["set", "smtp", VALUE]), 1);
  assert.match(h.err.join("\n"), /never taken from the command line/);
  assert.equal(h.printed().includes(VALUE), false);
  assert.deepEqual(await h.store.list(), []);
  assert.equal(h.prompts.length, 0);
});

test("secret set: bad name, cancel and empty value store nothing", async () => {
  const bad = harness();
  assert.equal(await bad.run(["set", "Not Valid"]), 1);
  assert.match(bad.err.join("\n"), /secret name must be lowercase/);
  assert.equal(bad.opened(), 0, "a bad name must fail before the store is opened");
  assert.equal(await bad.run(["set"]), 1);

  const cancelled = harness(null);
  assert.equal(await cancelled.run(["set", "smtp"]), 130);
  assert.deepEqual(await cancelled.store.list(), []);

  const empty = harness("");
  assert.equal(await empty.run(["set", "smtp"]), 1);
  assert.deepEqual(await empty.store.list(), []);
});

test("secret list: names and timestamps only, in text and JSON", async () => {
  const h = harness();
  assert.equal(await h.run(["list"]), 0);
  assert.match(h.out[0]!, /^\(no secrets\)/);
  await h.run(["set", "smtp"]);
  await h.run(["set", "gmail/work"]);
  h.out.length = 0;
  assert.equal(await h.run(["list"]), 0);
  assert.deepEqual(h.out, [
    "Secrets [memory] — values are never shown\n",
    "  secret://gmail/work  updated 2026-10-02 12:00",
    "  secret://smtp        updated 2026-10-02 12:00",
  ]);
  h.out.length = 0;
  assert.equal(await h.run(["list", "--json"]), 0);
  const parsed = JSON.parse(h.out.join("\n")) as { backend: string; secrets: object[] };
  assert.equal(parsed.backend, "memory");
  assert.deepEqual(
    parsed.secrets.map((s) => Object.keys(s).sort()),
    [
      ["createdAt", "name", "updatedAt"],
      ["createdAt", "name", "updatedAt"],
    ],
  );
  assert.equal(h.printed().includes(VALUE), false);
});

test("secret rm: removes, and reports a miss", async () => {
  const h = harness();
  await h.run(["set", "smtp"]);
  assert.equal(await h.run(["rm", "smtp"]), 0);
  assert.equal(await h.store.has("smtp"), false);
  assert.equal(await h.run(["rm", "smtp"]), 1);
  assert.match(h.err.at(-1)!, /nothing is stored as secret:\/\/smtp/);
  assert.equal(await h.run(["rm"]), 1);
});

test("secret: usage, unknown subcommand, and there is no `get`", async () => {
  const h = harness();
  assert.equal(await h.run([]), 1);
  assert.equal(await h.run(["help"]), 0);
  await h.run(["set", "smtp"]);
  for (const sub of ["get", "show", "cat", "export"]) {
    assert.equal(await h.run([sub, "smtp"]), 1, sub);
  }
  assert.equal(h.printed().includes(VALUE), false);
});

test("secret: store errors are shown by message; unexpected ones by type only", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  const unavailable = () => {
    throw new SecretStoreError(
      "unavailable",
      "the cloud secret store needs a signed-in tenant scope",
    );
  };
  assert.equal(await runSecretCommand(["list"], { ...deps, openStore: unavailable }), 1);
  assert.deepEqual(err, ["secret: the cloud secret store needs a signed-in tenant scope"]);

  err.length = 0;
  const weird = () => {
    throw new TypeError(`boom ${VALUE}`);
  };
  assert.equal(await runSecretCommand(["list"], { ...deps, openStore: weird }), 1);
  assert.deepEqual(err, ["secret: unexpected failure (TypeError)"]);
});

test("readPipedValue: drops exactly one trailing line ending, keeps the rest", async () => {
  assert.equal(await readPipedValue(Readable.from(["abc\n"])), "abc");
  assert.equal(await readPipedValue(Readable.from(["abc\r\n"])), "abc");
  assert.equal(await readPipedValue(Readable.from(["abc"])), "abc");
  assert.equal(await readPipedValue(Readable.from(["a", "b\n", "c\n\n"])), "ab\nc\n");
  assert.equal(await readPipedValue(Readable.from([" padded \n"])), " padded ");
  assert.equal(await readPipedValue(Readable.from([Buffer.from("钥匙\n")])), "钥匙");
  assert.equal(await readPipedValue(Readable.from([])), "");
  await assert.rejects(
    readPipedValue(Readable.from(["x".repeat(SECRET_VALUE_MAX_BYTES), "yyy"])),
    (e: unknown) => e instanceof SecretStoreError && e.code === "invalid_value",
  );
});

/** A stand-in TTY: emits what the "user" types, records raw-mode switches. */
class FakeTty extends EventEmitter implements PromptInput {
  isTTY = true;
  rawModes: boolean[] = [];
  paused = true;
  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
  setEncoding(): void {}
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  type(text: string): void {
    this.emit("data", text);
  }
}

test("promptHidden: echoes nothing but the prompt and a newline", async () => {
  const tty = new FakeTty();
  const written: string[] = [];
  const pending = promptHidden("Value: ", tty, (t) => written.push(t));
  tty.type("abx");
  tty.type("\u007f"); // backspace
  tty.type("\u001b[A"); // an arrow key must not end up in the value
  tty.type("c-钥\r");
  assert.equal(await pending, "abc-钥");
  assert.deepEqual(written, ["Value: ", "\n"]);
  assert.deepEqual(tty.rawModes, [true, false]);
  assert.equal(tty.paused, true);
  assert.equal(tty.listenerCount("data"), 0);
});

test("promptHidden: Ctrl-U clears, Ctrl-C and empty Ctrl-D cancel", async () => {
  const cleared = new FakeTty();
  const p1 = promptHidden("", cleared, () => {});
  cleared.type("wrong\u0015right\n");
  assert.equal(await p1, "right");

  const interrupted = new FakeTty();
  const p2 = promptHidden("", interrupted, () => {});
  interrupted.type("partial\u0003");
  assert.equal(await p2, null);
  assert.deepEqual(interrupted.rawModes, [true, false]);

  const eof = new FakeTty();
  const p3 = promptHidden("", eof, () => {});
  eof.type("\u0004");
  assert.equal(await p3, null);
});

test("cli args: `lisa secret …` routes to the subcommand with its flags intact", () => {
  const set = parseArgs(["secret", "set", "gmail/work"]);
  assert.equal(set.subcommand, "secret");
  assert.deepEqual(set.subargs, ["set", "gmail/work"]);
  const list = parseArgs(["secret", "list", "--json"]);
  assert.equal(list.subcommand, "secret");
  assert.deepEqual(list.subargs, ["list", "--json"]);
});
