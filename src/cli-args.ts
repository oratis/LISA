/**
 * CLI argument parsing — pure, so it is unit-testable without importing the CLI
 * entrypoint (`cli.ts` runs `main()` on import). `cli.ts` re-exports nothing but
 * consumes `parseArgs`/`ParsedArgs` from here.
 */
import fs from "node:fs";
import { APPROVAL_MODES, type ApprovalMode } from "./approval.js";
import { DEFAULT_MODEL } from "./llm.js";

export interface ParsedArgs {
  showHelp: boolean;
  reflect: boolean;
  thinking: boolean;
  compaction: boolean;
  model: string;
  approval: ApprovalMode;
  /** True when --approval was passed; otherwise `serve --web` also honours LISA_APPROVAL. */
  approvalExplicit: boolean;
  loadMcp: boolean;
  loadPlugins: boolean;
  voice: boolean;
  idleMinutes: number;
  /** True when --model was passed, so a LISA_MODEL default from config.env won't override it. */
  modelExplicit: boolean;
  /** `--verbose` or LISA_DEBUG=1: startup banners, full tool results, hot-reload details. */
  verbose: boolean;
  /** `--no-color`: force plain output even on a TTY (NO_COLOR is handled in cli/ansi.ts). */
  noColor: boolean;
  subcommand?:
    | "resume"
    | "sessions"
    | "serve"
    | "heartbeat"
    | "autostart"
    | "search"
    | "birth"
    | "soul"
    | "channels"
    | "skills"
    | "wishlist"
    | "status"
    | "doctor"
    | "monitor"
    | "autonomy"
    | "model"
    | "consent"
    | "reachout"
    | "sense"
    | "agents"
    | "pair"
    | "mail"
    | "kb"
    | "secret"
    | "login"
    | "logout"
    | "billing"
    | "upgrade"
    | "tasks"
    | "approvals"
    | "warden"
    | "forget"
    | "export"
    | "import";
  subargs: string[];
  serveWeb: boolean;
  serveImessage: boolean;
  serveChannels: string[];
  port: number;
  host: string;
  prompt: string | null;
}

/**
 * Subcommands that parse a few *recognized* global flags out of their trailing
 * args (`autostart install --port/--channels/--imessage`, `heartbeat run
 * --model`), so those must still reach the global parser — only *unrecognized*
 * trailing flags are collected verbatim for the handler.
 */
const RAW_SUBCOMMANDS = new Set(["heartbeat", "autostart", "doctor", "upgrade", "secret", "tasks"]);

/**
 * Subcommands whose handler re-parses *all* of its trailing args itself, so
 * every token after it must be collected verbatim — even ones that look like
 * global flags (`mail connect --host/--port/--provider …`), which would
 * otherwise be swallowed as global settings and never reach the handler.
 */
const PASSTHROUGH_SUBCOMMANDS = new Set(["mail", "kb", "billing", "approvals", "warden"]);

/**
 * Data commands (memory sovereignty). A one-shot prompt can start with these
 * words — `lisa export the report to pdf`, `lisa forget it, just say hi` — so
 * they are subcommands only when they are the FIRST word and the rest is
 * exactly that command's own form:
 *
 *   export [--out F] [--include-sessions] [--force]
 *   import <existing file> [--into H] [--replace]
 *   forget <topic> [--dry-run] [--yes] [--json]     (one positional: quote it)
 *
 * (`--help` / `-h` alone also qualifies.) Anything else is parsed exactly as
 * before these subcommands existed: a one-shot prompt, and an unknown flag is
 * still an error.
 */
const DATA_SUBCOMMANDS: Record<
  "export" | "import" | "forget",
  { flags: readonly string[]; valued: readonly string[] }
> = {
  export: { flags: ["--include-sessions", "--force"], valued: ["--out"] },
  import: { flags: ["--replace"], valued: ["--into"] },
  forget: { flags: ["--dry-run", "--yes", "--json"], valued: [] },
};

function isDataSubcommand(word: string | undefined): word is keyof typeof DATA_SUBCOMMANDS {
  return word === "export" || word === "import" || word === "forget";
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Do `rest` (the tokens after the word) form exactly `cmd`'s own command line? */
export function isDataCommandLine(
  cmd: keyof typeof DATA_SUBCOMMANDS,
  rest: readonly string[],
  isFile: (p: string) => boolean = defaultIsFile,
): boolean {
  const spec = DATA_SUBCOMMANDS[cmd];
  const positional: string[] = [];
  const seen = new Set<string>();
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (spec.valued.includes(name)) {
      if (seen.has(name)) return false;
      seen.add(name);
      if (eq > 0) {
        if (eq === a.length - 1) return false;
      } else {
        const v = rest[++i];
        if (v === undefined || v.startsWith("-")) return false;
      }
    } else if (a.startsWith("-")) {
      if (!spec.flags.includes(a) || seen.has(a)) return false;
      seen.add(a);
    } else {
      positional.push(a);
    }
  }
  if (help) return positional.length <= (cmd === "export" ? 0 : 1);
  if (cmd === "export") return positional.length === 0;
  if (cmd === "forget") return positional.length === 1;
  return positional.length === 1 && isFile(positional[0]!);
}

/**
 * Is this a debug run? Decided from the raw argv + env rather than ParsedArgs
 * because the proxy bridge runs at module load, before parseArgs — it must be
 * in place before any module touches fetch. LISA_DEBUG=1 is the env form for
 * launchd / scripts that can't edit the command line.
 */
export function isVerboseArgv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const debug = env.LISA_DEBUG;
  if (debug && debug !== "0" && debug.toLowerCase() !== "false") return true;
  return argv.includes("--verbose");
}

export function parseArgs(
  argv: string[],
  opts: { isFile?: (p: string) => boolean } = {},
): ParsedArgs {
  const parsed = parseArgvOnce(argv, true);
  if (
    isDataSubcommand(parsed.subcommand) &&
    !isDataCommandLine(parsed.subcommand, parsed.subargs, opts.isFile)
  ) {
    // Not the command's own form: parse it as before the subcommand existed.
    return parseArgvOnce(argv, false);
  }
  return parsed;
}

function parseArgvOnce(argv: string[], dataSubcommands: boolean): ParsedArgs {
  const out: ParsedArgs = {
    showHelp: false,
    reflect: true,
    thinking: false,
    compaction: false,
    model: DEFAULT_MODEL,
    modelExplicit: false,
    verbose: isVerboseArgv([], process.env),
    noColor: false,
    approval: "auto",
    approvalExplicit: false,
    loadMcp: true,
    loadPlugins: true,
    voice: false,
    idleMinutes: 60,
    subargs: [],
    serveWeb: false,
    serveImessage: false,
    serveChannels: [],
    port: 5757,
    host: "127.0.0.1",
    prompt: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Once a full-passthrough subcommand (mail) has appeared, every following
    // token is command-specific — collect it verbatim so global flag parsing
    // (e.g. --provider, --host, --email) cannot swallow or reject the
    // subcommand's own flags. Global flags still apply before the subcommand.
    // (heartbeat/autostart are NOT here: they read a few recognized global
    // flags — --port/--channels/--imessage/--model — so those must fall through
    // to the parser below; only their *unrecognized* flags are collected, in
    // the --flag branch.)
    if (
      positional.some((p) => PASSTHROUGH_SUBCOMMANDS.has(p)) ||
      (dataSubcommands && isDataSubcommand(positional[0]))
    ) {
      positional.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") out.showHelp = true;
    else if (arg === "--no-reflect") out.reflect = false;
    else if (arg === "--think" || arg === "--thinking") out.thinking = true;
    else if (arg === "--compact") out.compaction = true;
    else if (arg === "--no-mcp") out.loadMcp = false;
    else if (arg === "--no-plugins") out.loadPlugins = false;
    else if (arg === "--verbose") out.verbose = true;
    else if (arg === "--no-color" || arg === "--no-colour") out.noColor = true;
    else if (arg === "--voice") out.voice = true;
    else if (arg === "--no-idle") out.idleMinutes = 0;
    else if (arg === "--idle") {
      const v = mustNext(argv, ++i, "--idle");
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad --idle: ${v}`);
      out.idleMinutes = n;
    } else if (arg === "--web") out.serveWeb = true;
    else if (arg === "--imessage") out.serveImessage = true;
    else if (arg === "--channels") {
      out.serveChannels = mustNext(argv, ++i, "--channels")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--channels=")) {
      out.serveChannels = arg
        .slice("--channels=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--model") {
      out.model = mustNext(argv, ++i, "--model");
      out.modelExplicit = true;
    } else if (arg.startsWith("--model=")) {
      out.model = arg.slice("--model=".length);
      out.modelExplicit = true;
    } else if (arg === "--provider") {
      const v = mustNext(argv, ++i, "--provider");
      process.env.LISA_PROVIDER = v;
    } else if (arg === "--approval") {
      const v = mustNext(argv, ++i, "--approval") as ApprovalMode;
      if (!APPROVAL_MODES.includes(v)) {
        throw new Error(`bad --approval mode: ${v}`);
      }
      out.approval = v;
      out.approvalExplicit = true;
    } else if (arg === "--port") {
      out.port = parseInt(mustNext(argv, ++i, "--port"), 10);
    } else if (arg === "--host") {
      out.host = mustNext(argv, ++i, "--host");
    } else if (arg.startsWith("--host=")) {
      out.host = arg.slice("--host=".length);
    } else if (arg.startsWith("--")) {
      // An unrecognized --flag. After a raw-args subcommand (heartbeat/
      // autostart) it's command-specific — collect it verbatim instead of
      // rejecting (e.g. `autostart install --no-load`). Otherwise it's a
      // genuine unknown global flag. (mail's flags never reach here — they're
      // collected wholesale by the passthrough guard at the top of the loop.)
      if (positional.some((p) => RAW_SUBCOMMANDS.has(p))) {
        positional.push(arg);
      } else {
        throw new Error(`unknown flag: ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    const first = positional[0]!;
    if (
      first === "resume" ||
      first === "sessions" ||
      first === "serve" ||
      first === "heartbeat" ||
      first === "autostart" ||
      first === "search" ||
      first === "birth" ||
      first === "soul" ||
      first === "channels" ||
      first === "skills" ||
      first === "wishlist" ||
      first === "status" ||
      first === "doctor" ||
      first === "monitor" ||
      first === "autonomy" ||
      first === "model" ||
      first === "consent" ||
      first === "reachout" ||
      first === "sense" ||
      first === "agents" ||
      first === "pair" ||
      first === "mail" ||
      first === "kb" ||
      first === "secret" ||
      first === "login" ||
      first === "logout" ||
      first === "billing" ||
      first === "upgrade" ||
      first === "tasks" ||
      first === "approvals" ||
      first === "warden" ||
      (dataSubcommands && isDataSubcommand(first))
    ) {
      out.subcommand = first;
      out.subargs = positional.slice(1);
    } else {
      out.prompt = positional.join(" ");
    }
  }
  return out;
}

function mustNext(argv: string[], idx: number, flag: string): string {
  const v = argv[idx];
  if (!v) throw new Error(`${flag} requires a value`);
  return v;
}
