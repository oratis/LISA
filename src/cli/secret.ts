/**
 * `lisa secret <set|list|rm>` — manage the Warden secret store (plan W2b).
 *
 *   lisa secret set <name>     # value from a hidden prompt, or from stdin when piped
 *   lisa secret list [--json]  # names + timestamps; never values
 *   lisa secret rm <name>
 *
 * There is deliberately no `get`: nothing in LISA prints a stored value back.
 * Tools receive it at execution time through a `secret://<name>` handle.
 *
 * The value is never accepted as a command-line argument — it would land in
 * shell history and be visible to every local user through `ps`.
 */
import {
  SECRET_REF_SCHEME,
  SECRET_VALUE_MAX_BYTES,
  SecretStoreError,
  assertSecretName,
  type SecretStore,
} from "../warden/secrets.js";

const USAGE = [
  "usage:",
  "  lisa secret set <name>     store a secret (hidden prompt, or pipe the value on stdin)",
  "  lisa secret list [--json]  list names and timestamps (never values)",
  "  lisa secret rm <name>      delete a secret",
  "",
  "A name is lowercase [a-z0-9._-], optionally namespaced once: gmail/work.",
  "Refer to a stored secret as secret://<name>; the value itself is never shown.",
].join("\n");

/** The parts of a TTY stream the hidden prompt needs. */
export interface PromptInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface SecretCommandDeps {
  /** Opens the store. Defaults to the process's real store. */
  openStore?: () => SecretStore | Promise<SecretStore>;
  /** Reads the value for `set`. `null` means the user cancelled. */
  readValue?: (prompt: string) => Promise<string | null>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * Read a line from a TTY without echoing it. Resolves `null` on Ctrl-C, or on
 * Ctrl-D with nothing typed. Writes only the prompt and a final newline.
 */
export function promptHidden(
  prompt: string,
  input: PromptInput,
  write: (text: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = "";
    let inEscape = false;
    const finish = (value: string | null): void => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      write("\n");
      resolve(value);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const ch of chunk.toString()) {
        if (inEscape) {
          // Swallow an escape sequence (arrow keys etc.) up to its final byte.
          if (/[A-Za-z~]/.test(ch)) inEscape = false;
          continue;
        }
        if (ch === "\r" || ch === "\n") return finish(buf);
        if (ch === "\u0003") return finish(null);
        if (ch === "\u0004") return finish(buf.length > 0 ? buf : null);
        if (ch === "\u007f" || ch === "\b") {
          buf = [...buf].slice(0, -1).join("");
        } else if (ch === "\u0015") {
          buf = "";
        } else if (ch === "\u001b") {
          inEscape = true;
        } else if (ch >= " ") {
          buf += ch;
        }
      }
    };
    write(prompt);
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/**
 * Read a piped value to EOF. One trailing line ending is dropped (so
 * `echo value | lisa secret set x` and `printf value | …` store the same thing);
 * any other whitespace is kept, since it may be part of the secret.
 */
export async function readPipedValue(input: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += bytes.length;
    // +2 leaves room for the one line ending that is about to be dropped.
    if (size > SECRET_VALUE_MAX_BYTES + 2) {
      throw new SecretStoreError(
        "invalid_value",
        `secret value exceeds ${SECRET_VALUE_MAX_BYTES} bytes`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

function defaultReadValue(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) {
    return promptHidden(prompt, process.stdin, (text) => process.stderr.write(text));
  }
  return readPipedValue(process.stdin);
}

async function defaultOpenStore(): Promise<SecretStore> {
  const { openSecretStore } = await import("../warden/secrets-open.js");
  return openSecretStore();
}

/** Accept `gmail/work` or `secret://gmail/work`. */
function nameArg(raw: string): string {
  const name = raw.startsWith(SECRET_REF_SCHEME) ? raw.slice(SECRET_REF_SCHEME.length) : raw;
  assertSecretName(name);
  return name;
}

function when(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export async function runSecretCommand(
  args: string[],
  deps: SecretCommandDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const openStore = deps.openStore ?? defaultOpenStore;
  const readValue = deps.readValue ?? defaultReadValue;
  const [sub, ...rest] = args;

  try {
    if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
      out(USAGE);
      return sub ? 0 : 1;
    }

    if (sub === "set") {
      if (rest.length === 0) {
        err("usage: lisa secret set <name>");
        return 1;
      }
      if (rest.length > 1) {
        err(
          "secret: the value is never taken from the command line — it would be saved in " +
            "your shell history and visible to other users through `ps`.\n" +
            "Run `lisa secret set <name>` and type it at the hidden prompt, or pipe it in.",
        );
        return 1;
      }
      const name = nameArg(rest[0]!);
      const store = await openStore();
      const value = await readValue(`Value for secret://${name} (input hidden): `);
      if (value === null) {
        err("secret: cancelled, nothing stored");
        return 130;
      }
      if (value.length === 0) {
        err("secret: empty value, nothing stored");
        return 1;
      }
      const existed = await store.has(name);
      await store.set(name, value);
      out(`${existed ? "updated" : "stored"} secret://${name} (${store.backend})`);
      return 0;
    }

    if (sub === "list" || sub === "ls") {
      const store = await openStore();
      const metas = await store.list();
      if (rest.includes("--json")) {
        out(JSON.stringify({ backend: store.backend, secrets: metas }, null, 2));
        return 0;
      }
      if (metas.length === 0) {
        out(`(no secrets) — add one with \`lisa secret set <name>\`  [${store.backend}]`);
        return 0;
      }
      out(`Secrets [${store.backend}] — values are never shown\n`);
      const width = Math.max(...metas.map((m) => m.name.length)) + SECRET_REF_SCHEME.length;
      for (const m of metas) {
        out(`  ${(SECRET_REF_SCHEME + m.name).padEnd(width)}  updated ${when(m.updatedAt)}`);
      }
      return 0;
    }

    if (sub === "rm" || sub === "remove" || sub === "delete") {
      if (rest.length !== 1) {
        err("usage: lisa secret rm <name>");
        return 1;
      }
      const name = nameArg(rest[0]!);
      const store = await openStore();
      if (!(await store.remove(name))) {
        err(`secret: nothing is stored as secret://${name}`);
        return 1;
      }
      out(`removed secret://${name}`);
      return 0;
    }

    err(`unknown secret subcommand: ${sub}\n${USAGE}`);
    return 1;
  } catch (e) {
    // SecretStoreError messages are written to be shown and never carry a value.
    // Anything else is reported by type only — an unexpected error's message is
    // not something this command can vouch for.
    if (e instanceof SecretStoreError) err(`secret: ${e.message}`);
    else err(`secret: unexpected failure (${e instanceof Error ? e.name : "error"})`);
    return 1;
  }
}
